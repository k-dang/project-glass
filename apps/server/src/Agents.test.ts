import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  AgentStarted,
  AllowRequest,
  type Image,
  isRequestPart,
  isWaiting,
  TextPart,
  TextPatch,
  thisMac,
  ThinkingPart,
  TOKEN_PARAM,
  type Transcript,
  type Turn,
  TurnCutOff,
  TurnDone,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { Socket } from "effect/socket"
import { execFileSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { agentsFixture, claudeCode, lastText, repository, settled } from "../test/agentsFixture"
import { type FakeModelRequest, runCommands } from "../test/fakeModelProvider"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome, LAUNCH_TOKEN, startSignedInBackend } from "../test/harness"
import { AgentHostRpcs } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import { vi } from "vite-plus/test"

const processes = (): ReadonlyArray<{ pid: number; ppid: number; command: string }> =>
  process.platform === "win32"
    ? JSON.parse(
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = [string]$_.CommandLine } } | ConvertTo-Json -Compress",
          ],
          { encoding: "utf8" },
        ),
      )
    : execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .map(([pid, ppid, ...words]) => ({
          pid: Number(pid),
          ppid: Number(ppid),
          command: words.join(" "),
        }))

const childProcesses = (parent: number, command: string) =>
  processes()
    .filter((child) => child.ppid === parent && child.command.includes(command))
    .map((child) => child.pid)

const startedHost = (before: ReadonlyArray<number>) =>
  childProcesses(process.pid, "agentHost.mjs").find((pid) => !before.includes(pid))

vi.stubEnv("PI_OFFLINE", "1")

const userMessages = ({ messages }: FakeModelRequest) =>
  messages.filter(({ role }) => role === "user").map(({ content }) => JSON.stringify(content))

const toTestBackend = (url: string | URL) => String(url).includes(`${TOKEN_PARAM}=${LAUNCH_TOKEN}`)

const unreachable = "ws://127.0.0.1:9/"

const droppableHostConnections = Effect.gen(function* () {
  const makeWebSocket = yield* Socket.WebSocketConstructor.pipe(
    Effect.provide(NodeSocket.layerWebSocketConstructor),
  )

  const open = new Set<Socket.WebSocketLike>()
  let host: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined
  let offline = false
  let opened = 0

  const constructor: Socket.WebSocketConstructor["Service"] = (url, options) => {
    const toHost = !toTestBackend(url)
    const socket = makeWebSocket(toHost && offline ? unreachable : url, options)

    if (toHost) {
      if (options !== undefined && !Predicate.isString(options) && !Array.isArray(options))
        host = { url, headers: options.headers ?? {} }

      socket.addEventListener("open", () => {
        opened++
        open.add(socket)
      })
      socket.addEventListener("close", () => open.delete(socket))
    }

    return socket
  }

  return {
    constructor,
    witness: Effect.gen(function* () {
      if (host === undefined) return yield* Effect.die("The test hasn't connected to a host")

      return yield* connectRpcClient(AgentHostRpcs, host.url, host.headers).pipe(
        Effect.provideService(Socket.WebSocketConstructor, makeWebSocket),
      )
    }),
    opened: () => opened,
    drop: Effect.gen(function* () {
      offline = true
      const sockets = [...open]
      assert.isAbove(sockets.length, 0, "The test must drop an open host connection")

      yield* Effect.forEach(sockets, (socket) =>
        Effect.callback<void>((resume) => {
          const closed = () => resume(Effect.void)
          socket.addEventListener("close", closed, { once: true })
          socket.close(3000, "dropped")

          return Effect.sync(() => socket.removeEventListener("close", closed))
        }),
      )
    }),
    reconnect: Effect.sync(() => {
      offline = false
    }),
  }
})

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const elsewhere = yield* isolatedHome
    const unpublished = join(elsewhere, "unpublished")
    gitIn(elsewhere, "init", "--quiet", unpublished)

    for (const path of [elsewhere, unpublished]) {
      const refused = yield* f.client.LinkLocalCheckout({ path }).pipe(Effect.flip)
      assert.equal(refused._tag, "InvalidLocalCheckout")
    }

    yield* Effect.promise(() => mkdir(join(f.clone.checkout, "src")))

    const linked = yield* f.client.LinkLocalCheckout({ path: join(f.clone.checkout, "src") })

    assert.deepStrictEqual(linked.repository, repository)
    assert.equal(linked.path, gitIn(f.clone.checkout, "rev-parse", "--show-toplevel"))

    const restarted = yield* f.restart
    const [kept] = yield* restarted.ListLocalCheckouts()
    assert.deepStrictEqual(kept?.repository, repository)
    assert.equal(kept?.path, linked.path)

    const branches = yield* restarted.ListBranches({ repository })
    assert.equal(branches.defaultBranch, "main")
    assert.sameMembers([...branches.branches], ["main", "develop"])
  }),
)

it.live("lists a Followed repository's branches from GitHub, for a Sandbox", () =>
  Effect.gen(function* () {
    const { github, client } = yield* startSignedInBackend
    const features = Array.from({ length: 150 }, (_, index) => `feature/${index}`)
    github.seedBranches(repository, {
      defaultBranch: "develop",
      branches: ["main", "develop", ...features],
    })

    const branches = yield* client.ListGitHubBranches({ repository })
    assert.equal(branches.defaultBranch, "develop")
    assert.sameMembers([...branches.branches], ["main", "develop", ...features])

    const missing = yield* client
      .ListGitHubBranches({ repository: { owner: "glass-demo", repo: "nowhere" } })
      .pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")
  }),
)

it.live("starts an Agent in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello!" })
    const agent = yield* f.start()
    const other = yield* f.start()
    const worktree = f.worktree(agent.name)

    assert.match(agent.name, /^agent\//)
    assert.notEqual(other.name, agent.name)
    assert.equal(gitIn(worktree, "branch", "--show-current"), agent.name)
    assert.equal(gitIn(worktree, "rev-parse", "HEAD"), f.clone.main)

    const [listed] = yield* f.client
      .WatchAgents()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(
      { id: listed?.id, place: listed?.place, repository: listed?.repository },
      { id: agent.id, place: thisMac, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      AgentStarted.make({
        agentId: agent.id,
        name: agent.name,
        repository,
        machine: "this-mac",
        engine: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live("streams thinking, tool calls, and text into a Turn that ends done once pi settles", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({
      reply: ({ messages }) =>
        messages.some(({ role }) => role === "tool")
          ? [{ text: "It says " }, { text: "hi." }]
          : [
              { thinking: "I should run echo." },
              { toolCall: { id: "call-1", name: "bash", arguments: { command: "echo hi" } } },
            ],
    })

    const agent = yield* f.start("Run echo")
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.equal(turn?.message, "Run echo")
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(
      turn?.parts.map((part) =>
        Predicate.isTagged(part, "ToolCall")
          ? {
              name: part.name,
              summary: part.inputSummary,
              output: part.output?.trim(),
              status: part.status,
            }
          : part,
      ),
      [
        ThinkingPart.make({ text: "I should run echo." }),
        { name: "bash", summary: "echo hi", output: "hi", status: "done" },
        TextPart.make({ text: "It says hi." }),
      ],
    )
  }),
)

it.live("ends a Turn when pi settles after retrying, not at the first agent_end", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(
      { output: "Recovered.", failFirst: 1 },
      { retry: { enabled: true, maxRetries: 1, baseDelayMs: 50 } },
    )

    const agent = yield* f.start()
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepInclude(turn?.parts ?? [], TextPart.make({ text: "Recovered." }))
    assert.lengthOf(f.model.calls, 2)
  }),
)

it.live("fails a Turn with a reason that leaves out the provider's own words", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "secret-key-123 is not a valid API key", status: 401 })
    const agent = yield* f.start()
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.equal(turn?.ended?.ending._tag, "Failed")
    const ending = turn?.ended?.ending
    const reason = Predicate.isTagged(ending, "Failed") ? ending.reason : ""
    assert.include(reason, "sign in")
    assert.notInclude(reason, "secret-key-123")
  }),
)

it.live("continues the same conversation in later Turns", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Noted." })
    const agent = yield* f.start("Remember the word lantern")
    yield* f.transcript(agent.id, settled(1))

    yield* f.send(agent.id, "What was the word?")
    const turns = yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(
      turns.map(({ message, ended }) => ({ message, ending: ended?.ending })),
      [
        { message: "Remember the word lantern", ending: TurnDone.make({}) },
        { message: "What was the word?", ending: TurnDone.make({}) },
      ],
    )
    const asked = userMessages(f.model.calls.at(-1)!)
    assert.isTrue(asked.some((content) => content.includes("lantern")))
  }),
)

const pixel: Image = {
  mediaType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
}

const queuedMessages = ({ queued }: Transcript) => queued.map(({ message }) => message)

const holding = { output: "Done.", hang: true }

const shownParts = (turn: Turn | undefined) =>
  turn?.parts.map((part) =>
    Predicate.isTagged(part, "Steer")
      ? { steer: part.message }
      : Predicate.isTagged(part, "Text")
        ? { text: part.text }
        : part._tag,
  )

it.live("Steers a pi Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(holding)
    const agent = yield* f.start("Start")
    yield* f.model.received(1)

    yield* f.steer(agent.id, "Change course")
    yield* f.model.release({
      output: ({ messages }) =>
        JSON.stringify(messages).includes("Change course") ? "Changed." : "Started.",
    })

    const [turn] = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(turn), [
      { text: "Started." },
      { steer: "Change course" },
      { text: "Changed." },
    ])
  }),
)

it.live(
  "stops a pi Turn, keeping Queued messages and putting back a Steer pi hadn't taken in",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(holding)
      const agent = yield* f.start()
      yield* f.model.received(1)

      yield* f.send(agent.id, "Later")
      yield* f.steer(agent.id, "Now, please")
      yield* f.client.StopTurn({ agentId: agent.id })

      const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
      assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
      assert.deepStrictEqual(shownParts(stopped.turns[0]), [])
      assert.deepStrictEqual(queuedMessages(stopped), ["Now, please", "Later"])
      yield* f.model.cancelled(1)
    }),
)

const inputExtension = (home: string) =>
  Effect.promise(async () => {
    const extensions = join(home, ".pi", "agent", "extensions")
    await mkdir(extensions, { recursive: true })
    await writeFile(
      join(extensions, "input.js"),
      `export default (pi) => pi.on("input", async (event) => {
        if (event.text === "ping") return { action: "handled" }
        if (event.text === "remind me") {
          pi.sendUserMessage("Check the tests", { deliverAs: "followUp" })
          return { action: "handled" }
        }
        if (event.text.startsWith("?quick ")) return { action: "transform", text: "Briefly: " + event.text.slice(7) }
        return { action: "continue" }
      })`,
    )
  })

it.live("shows a Steer a pi extension handles itself, without Queueing it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture(holding)
    yield* inputExtension(f.home)
    const agent = yield* f.start()
    yield* f.model.received(1)

    yield* f.steer(agent.id, "ping")
    yield* f.model.release({ output: "Done." })

    const done = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(shownParts(done.turns[0]), [{ steer: "ping" }, { text: "Done." }])
    assert.deepStrictEqual(done.queued, [])
    assert.lengthOf(f.model.calls, 1)
  }),
)

it.live(
  "puts back what pi held when the Turn stops: Steers as the user wrote them, then pi's own",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(holding)
      yield* inputExtension(f.home)
      const agent = yield* f.start()
      yield* f.model.received(1)

      yield* f.steer(agent.id, "?quick tabs or spaces?", [pixel])
      yield* f.steer(agent.id, "remind me")
      yield* f.client.StopTurn({ agentId: agent.id })

      const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
      assert.deepStrictEqual(
        stopped.queued.map(({ message, images }) => ({ message, images })),
        [
          { message: "?quick tabs or spaces?", images: [pixel] },
          { message: "Check the tests", images: [] },
        ],
      )
    }),
)

it.live("sends a message's images to pi and keeps them in the transcript", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "A pixel." })
    const agent = yield* f.start("What's this?", undefined, [pixel])
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.images, [pixel])
    assert.include(
      JSON.stringify(f.model.calls[0]?.messages),
      `data:image/png;base64,${pixel.data}`,
    )
  }),
)

it.live(
  "cuts off the running Turn when the agent host dies, and starts a new host for the next message",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ hang: true })
      const earlierHosts = childProcesses(process.pid, "agentHost.mjs")
      const agent = yield* f.start()
      yield* f.model.received(1)

      const host = startedHost(earlierHosts)
      assert.isDefined(host, "the backend has no agent host running")
      process.kill(host, "SIGKILL")

      const [cutOff] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      yield* f.send(agent.id, "Try again")
      yield* f.model.received(2)
    }),
)

const hasWaiting = ({ parts }: Turn) => parts.some(isWaiting)

it.live(
  "retires a Permission request waiting when the agent host dies, and the next message resumes the conversation",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({})
      const earlierHosts = childProcesses(process.pid, "agentHost.mjs")

      const agent = yield* f.start("Please run `touch notes.txt`", {
        ...claudeCode,
        permissionMode: "default",
      })

      const [waiting] = yield* f.transcript(agent.id, (turns) => turns.some(hasWaiting))
      const request = waiting?.parts.find(isWaiting)

      const host = startedHost(earlierHosts)
      assert.isDefined(host, "the backend has no agent host running")
      process.kill(host, "SIGKILL")

      const [cutOff] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))
      assert.equal(cutOff?.parts.find(isRequestPart)?.status, "expired")

      const marked = yield* f.client.WatchWaitingAgents().pipe(Stream.runHead)
      assert.deepStrictEqual(Option.getOrThrow(marked), [])

      const refused = yield* f.client
        .AnswerRequest({
          agentId: agent.id,
          requestId: request?.requestId ?? "",
          answer: AllowRequest.make({}),
        })
        .pipe(Effect.flip)

      assert.equal(refused._tag, "RequestNotWaiting")

      yield* f.send(agent.id, "Try again")
      const [, again] = yield* f.answering(agent.id, settled(2), () => AllowRequest.make({}))
      assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
      assert.include(
        JSON.stringify(f.claude.calls.at(-1)?.messages),
        "Please run `touch notes.txt`",
      )
    }),
)

it.live("fails the running Turn when pi exits, and starts pi again for the next message", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ hang: true })
    const earlierHosts = childProcesses(process.pid, "agentHost.mjs")
    const agent = yield* f.start()
    yield* f.model.received(1)

    const host = startedHost(earlierHosts)
    const [pi] = host === undefined ? [] : childProcesses(host, "pi")
    assert.isDefined(pi, "the agent host has no pi running")
    process.kill(pi, "SIGKILL")

    const [failed] = yield* f.transcript(agent.id, settled(1))
    const ending = failed?.ended?.ending
    assert.include(Predicate.isTagged(ending, "Failed") ? ending.reason : "", "pi stopped")

    // A killed pi can leave this lock, which the next pi waits 30 seconds to call stale.
    rmSync(join(f.home, ".pi", "agent", "models-store.json.lock"), { recursive: true, force: true })

    yield* f.send(agent.id, "Try again")
    yield* f.model.received(2)
    assert.include(childProcesses(process.pid, "agentHost.mjs"), host)
  }),
)

it.live(
  "removes an Agent's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ hang: true })
      const agent = yield* f.start()
      const worktree = f.worktree(agent.name)
      yield* f.model.received(1)

      const clean = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(clean.uncommittedChanges, "none")

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "work in progress"))
      const dirty = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(dirty.uncommittedChanges, "some")

      yield* f.client.RemoveAgent({ agentId: agent.id })

      assert.isFalse(existsSync(worktree))
      assert.equal(
        gitIn(f.clone.checkout, "branch", "--list", agent.name).replace("*", "").trim(),
        agent.name,
      )
      assert.lengthOf(
        yield* f.client.WatchAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        0,
      )

      const gone = yield* f.client
        .WatchTranscript({ agentId: agent.id })
        .pipe(Stream.runHead, Effect.flip)

      assert.equal(gone._tag, "AgentNotFound")

      yield* f.model.cancelled(1)
    }),
)

it.live(
  "diffs an Agent's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({
        reply: runCommands({
          "Make changes": [
            "printf 'done\\n' > committed.txt && git add committed.txt",
            "git -c user.name=Agent -c user.email=agent@glass.invalid commit --quiet --no-gpg-sign -m Commit",
            "printf 'staged \\n' > staged.txt && git add staged.txt",
            "mkdir 'docs dir' && mv README.md 'docs dir/read é.md'",
            "printf 'hello\\n' > notes.txt && printf '\\000\\001' > logo.bin",
          ].join(" && "),
        }),
      })

      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))

      const git = () => ({
        head: gitIn(worktree, "rev-parse", "HEAD"),
        branch: gitIn(worktree, "branch", "--show-current"),
        status: gitIn(worktree, "status", "--porcelain", "-uall"),
      })

      const before = git()
      const files = yield* f.client.GetAgentChanges({ agentId: agent.id })
      assert.deepStrictEqual(git(), before)
      assert.equal(before.branch, agent.name)
      assert.notEqual(before.head, f.clone.main)

      assert.deepStrictEqual(
        files.map(
          (file) =>
            `${file.changeType} ${file.previousPath === null ? "" : `${file.previousPath} → `}${file.path} +${file.additions} -${file.deletions} ${file.patch._tag}`,
        ),
        [
          "added committed.txt +1 -0 TextPatch",
          "renamed README.md → docs dir/read é.md +0 -0 NoTextChanges",
          "added logo.bin +0 -0 BinaryFile",
          "added notes.txt +1 -0 TextPatch",
          "added staged.txt +1 -0 TextPatch",
        ],
      )

      assert.deepStrictEqual(
        files.find(({ path }) => path === "staged.txt")?.patch,
        TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+staged " }),
      )
    }),
)

it.live(
  "marks a running pi Turn interrupted after a relaunch, and continues the conversation",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({})

      const replyWithEarlier = f.model.configure({
        output: (input) => `Earlier: ${userMessages(input).slice(0, -1).join(" | ")}`,
      })

      yield* replyWithEarlier
      const agent = yield* f.start("Remember the word lantern")
      yield* f.transcript(agent.id, settled(1))

      yield* f.model.configure({ hang: true })
      yield* f.send(agent.id, "Keep going")
      yield* f.transcript(agent.id, (turns) => turns.length === 2)

      const restarted = yield* f.restart
      yield* replyWithEarlier
      yield* restarted.SendMessage({ agentId: agent.id, message: "What was the word?", images: [] })
      const turns = yield* f.transcript(agent.id, settled(3), restarted)

      assert.deepStrictEqual(
        turns.map(({ ended }) => ended?.ending),
        [TurnDone.make({}), TurnInterrupted.make({}), TurnDone.make({})],
      )
      assert.include(lastText(turns[2])?.text, "lantern")
    }),
)

it.live(
  "fills in what it missed while it lost its connection to the agent host, repeating nothing",
  () =>
    Effect.gen(function* () {
      const connections = yield* droppableHostConnections

      const f = yield* agentsFixture({}).pipe(
        Effect.provideService(Socket.WebSocketConstructor, connections.constructor),
      )

      const agent = yield* f.start("First", claudeCode)
      yield* f.transcript(agent.id, settled(1))
      const opened = connections.opened()

      yield* f.claude.hold
      yield* f.send(agent.id, "Second")
      const running = yield* f.transcript(agent.id, (turns) => turns.length === 2)
      const secondTurnId = running[1]!.id

      yield* f.claude.received(2)
      yield* connections.drop
      yield* f.claude.release

      const witness = yield* connections.witness
      yield* witness.WatchJournal({ after: 0 }).pipe(
        Stream.filter(
          ({ agentId, event }) =>
            agentId === agent.id &&
            Predicate.isTagged(event, "TurnEnded") &&
            event.turnId === secondTurnId,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const beforeReconnect = yield* f.transcript(agent.id, (turns) => turns.length === 2)
      assert.isNull(beforeReconnect[1]?.ended)
      assert.isUndefined(lastText(beforeReconnect[1]))
      yield* connections.reconnect

      const turns = yield* f.transcript(agent.id, settled(2))
      assert.isAbove(connections.opened(), opened)

      assert.deepStrictEqual(
        turns.map((turn) => ({ parts: turn.parts, ending: turn.ended?.ending })),
        [
          {
            parts: [TextPart.make({ text: "Fake reply to: First" })],
            ending: TurnDone.make({}),
          },
          {
            parts: [TextPart.make({ text: "Fake reply to: Second" })],
            ending: TurnDone.make({}),
          },
        ],
      )
    }),
)

it.live("cuts off the running Turn when its output can't be saved, and keeps the Agent going", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello from pi." })
    const database = new DatabaseSync(join(f.home, ".project-glass", "glass.db"))

    try {
      database.exec(`
        CREATE TRIGGER refuse_parts BEFORE INSERT ON agent_turn_part
        BEGIN SELECT RAISE(FAIL, 'disk full'); END
      `)
      const agent = yield* f.start("First")
      const [cutOff] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      database.exec("DROP TRIGGER refuse_parts")
      yield* f.send(agent.id, "Second")
      const turns = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(turns[1]?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Hello from pi." }))
    } finally {
      database.close()
    }
  }),
)

it.live("lists the models and efforts pi offers, with its default", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const pi = yield* f.client.ListAgentModels({ engine: "pi", place: thisMac })
    assert.equal(pi.defaultModel?.id, "glass-test/gpt-test")
    // pi also lists the models of any other provider this machine has credentials for.
    assert.deepStrictEqual(
      pi.models.filter(({ id }) => id.startsWith("glass-test/")),
      [
        { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
        {
          id: "glass-test/gpt-test-thinking",
          name: "GPT Test Thinking",
          efforts: ["off", "minimal", "low", "medium", "high"],
        },
      ],
    )
  }),
)

it.live(
  "lists only the models pi is scoped to, including an extension's, in its order, starting on one of them",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(
        {},
        {
          enabledModels: ["glass-extension/extension-model", "glass-test/*thinking"],
        },
      )

      yield* Effect.promise(async () => {
        const extensions = join(f.home, ".pi", "agent", "extensions")
        await mkdir(extensions, { recursive: true })
        await writeFile(
          join(extensions, "provider.js"),
          `export default (pi) => pi.registerProvider("glass-extension", {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test-extension-key",
          api: "openai-completions",
          models: [{
            id: "extension-model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }],
        })`,
        )
      })

      const pi = yield* f.client.ListAgentModels({ engine: "pi", place: thisMac })
      assert.equal(pi.defaultModel?.id, "glass-extension/extension-model")
      assert.deepStrictEqual(
        pi.models.map(({ id }) => id),
        ["glass-extension/extension-model", "glass-test/gpt-test-thinking"],
      )
    }),
)

it.live(
  "starts a pi Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Hi." })

      const agent = yield* f.start("Say hello", {
        engine: "pi",
        model: "glass-test/gpt-test-thinking",
        effort: "high",
      })

      yield* f.transcript(agent.id, settled(1))
      yield* f.client.ChangeAgentModel({ agentId: agent.id, model: null, effort: null })

      const [listed] = yield* f.client
        .WatchAgents()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.deepStrictEqual(
        { model: listed?.model, effort: listed?.effort },
        { model: null, effort: null },
      )

      yield* f.send(agent.id, "Again")
      yield* f.transcript(agent.id, settled(2))

      assert.deepStrictEqual(
        f.model.calls.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })),
        [
          { model: "gpt-test-thinking", reasoning_effort: "high" },
          { model: "gpt-test", reasoning_effort: undefined },
        ],
      )
    }),
)

it.live("runs a pi Agent's next Turn on pi's own thinking level once its effort is cleared", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hi." })
    const thinker = { engine: "pi", model: "glass-test/gpt-test-thinking" } as const

    const agent = yield* f.start("Say hello", { ...thinker, effort: "high" })
    yield* f.transcript(agent.id, settled(1))

    yield* f.client.ChangeAgentModel({ agentId: agent.id, model: thinker.model, effort: null })
    yield* f.send(agent.id, "Again")
    yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(
      f.model.calls.map(({ reasoning_effort }) => reasoning_effort),
      ["high", "medium"],
    )
  }),
)

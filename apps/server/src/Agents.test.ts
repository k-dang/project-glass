import { assert, it } from "@effect/vitest"
import {
  AgentStarted,
  AllowRequest,
  type Image,
  isRequestPart,
  isWaiting,
  type NewAgent,
  nothingUnsent,
  TextPart,
  TextPatch,
  thisMac,
  ThinkingPart,
  TOKEN_PARAM,
  type Transcript,
  type Turn,
  TurnCutOff,
  TurnDone,
  type TurnPart,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { execFileSync } from "node:child_process"
import { existsSync, realpathSync, rmSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { agentsFixture, claudeCode, lastText, repository, settled } from "../test/agentsFixture"
import { type FakeModelRequest, runCommands } from "../test/fakeModelProvider"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome, LAUNCH_TOKEN, startSignedInBackend } from "../test/harness"
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

const droppableHostConnections = Effect.acquireRelease(
  Effect.sync(() => {
    const Real = globalThis.WebSocket
    const open = new Set<WebSocket>()
    let offline = false

    class Intercepted extends Real {
      constructor(url: string | URL, protocols?: string | Array<string>) {
        const toHost = !toTestBackend(url)
        super(toHost && offline ? unreachable : url, protocols)

        if (toHost) {
          open.add(this)
          this.addEventListener("close", () => open.delete(this))
        }
      }
    }

    vi.stubGlobal("WebSocket", Intercepted)

    return {
      drop: () => {
        offline = true

        for (const socket of open) socket.close(3000, "dropped")
      },
      reconnect: () => {
        offline = false
      },
    }
  }),
  () => Effect.sync(() => vi.unstubAllGlobals()),
)

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
        engine: "pi-cli",
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

const endings = (turns: ReadonlyArray<Turn>) =>
  turns.map(({ message, ended }) => ({ message, ending: ended?.ending._tag }))

const holding = { output: "Done.", hang: true }

for (const engine of ["pi-cli", "claude-code"] as const)
  it.live(
    `queues messages sent while a ${engine} Turn runs, starting them in order as Turns end, except a cancelled one`,
    () =>
      Effect.gen(function* () {
        const f = yield* agentsFixture(holding, undefined, { hang: true })
        const agent = yield* f.start("First", { engine, model: null, effort: null })
        yield* f.transcript(agent.id, (turns) => turns.length === 1)

        for (const message of ["Second", "Third", "Fourth"]) yield* f.send(agent.id, message)

        const waiting = yield* f.watch(agent.id, ({ queued }) => queued.length === 3)
        assert.deepStrictEqual(queuedMessages(waiting), ["Second", "Third", "Fourth"])

        const third = waiting.queued[1]?.id ?? ""
        yield* f.client.CancelQueuedMessage({ agentId: agent.id, queuedMessageId: third })
        yield* f.watch(agent.id, ({ queued }) => queued.length === 2)

        yield* f.model.release({ output: "Done." })
        yield* f.claude.configure({})

        const done = yield* f.watch(agent.id, ({ turns }) => settled(3)(turns))
        assert.deepStrictEqual(endings(done.turns), [
          { message: "First", ending: "Done" },
          { message: "Second", ending: "Done" },
          { message: "Fourth", ending: "Done" },
        ])
        assert.deepStrictEqual(done.queued, [])
      }),
  )

it.live(
  "keeps Queued messages when a relaunch interrupts the Turn, to send when the user chooses",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(holding)
      const agent = yield* f.start()
      yield* f.model.received(1)
      yield* f.send(agent.id, "Again")

      const restarted = yield* f.restart
      yield* f.model.release({ output: "Done." })

      const interrupted = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns), restarted)
      assert.deepStrictEqual(interrupted.turns[0]?.ended?.ending, TurnInterrupted.make({}))
      assert.deepStrictEqual(queuedMessages(interrupted), ["Again"])

      const [again] = interrupted.queued
      yield* restarted.SendQueuedMessage({ agentId: agent.id, queuedMessageId: again?.id ?? "" })

      const sent = yield* f.watch(agent.id, ({ turns }) => settled(2)(turns), restarted)
      assert.deepStrictEqual(endings(sent.turns), [
        { message: "Say hello", ending: "Interrupted" },
        { message: "Again", ending: "Done" },
      ])
      assert.deepStrictEqual(sent.queued, [])
    }),
)

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

it.live("Steers a Claude Code Turn, which takes the message in before it ends", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { hang: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.transcript(agent.id, (turns) => turns.length === 1)
    yield* f.claude.logged("prompt", 1)

    yield* f.steer(agent.id, "Change course")

    const done = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(done.turns[0]?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(shownParts(done.turns[0]), [
      { steer: "Change course" },
      { text: "Taken in: Change course" },
    ])
    assert.deepStrictEqual(done.queued, [])
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

it.live("stops a Claude Code Turn, keeping its Queued messages", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { hang: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.claude.logged("prompt", 1)

    yield* f.send(agent.id, "Later")
    yield* f.client.StopTurn({ agentId: agent.id })

    const stopped = yield* f.watch(agent.id, ({ turns }) => settled(1)(turns))
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.deepStrictEqual(queuedMessages(stopped), ["Later"])
  }),
)

it.live("stops a Turn whose program is still starting, which never gets the message", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { holdStart: true })
    const agent = yield* f.start("Start", claudeCode)
    yield* f.claude.logged("control", 1)

    yield* f.client.StopTurn({ agentId: agent.id })
    const [stopped] = yield* f.transcript(agent.id, settled(1))
    assert.deepStrictEqual(stopped?.ended?.ending, TurnStopped.make({}))

    yield* f.claude.configure({})
    yield* f.send(agent.id, "Next")
    yield* f.transcript(agent.id, settled(2))

    const prompts = (yield* f.claude.log).flatMap((entry) =>
      entry.kind === "prompt" ? [entry.prompt] : [],
    )

    assert.deepStrictEqual(prompts, ["Next"])
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

it.live("sends a message's images to Claude Code", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
    const agent = yield* f.start("What's this?", claudeCode, [pixel])
    yield* f.transcript(agent.id, settled(1))

    const prompts = (yield* f.claude.log).filter(({ kind }) => kind === "prompt")
    assert.deepStrictEqual(
      prompts.map((entry) => entry.kind === "prompt" && entry.images),
      [["image/png"]],
    )
  }),
)

it.live("keeps an Agent's unsent message across a relaunch until it is cleared", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hi." })
    const agent = yield* f.start()
    const unsent = { message: "Half a thought", images: [pixel] }
    yield* f.client.SaveUnsentMessage({ agentId: agent.id, ...unsent })

    const restarted = yield* f.restart
    const kept = yield* restarted.GetUnsentMessage({ agentId: agent.id })
    assert.deepStrictEqual({ message: kept.message, images: kept.images }, unsent)

    yield* restarted.SaveUnsentMessage({ agentId: agent.id, ...nothingUnsent })
    const cleared = yield* restarted.GetUnsentMessage({ agentId: agent.id })
    assert.deepStrictEqual({ message: cleared.message, images: cleared.images }, nothingUnsent)
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
      const f = yield* agentsFixture({}, undefined, {
        reply: [
          {
            toolCall: { id: "bash-1", name: "Bash", input: { command: "ls" }, output: "README.md" },
          },
          { text: "Earlier: {earlier}" },
        ],
      })

      const earlierHosts = childProcesses(process.pid, "agentHost.mjs")
      const agent = yield* f.start("List files", { ...claudeCode, permissionMode: "default" })
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
      assert.deepStrictEqual(lastText(again), TextPart.make({ text: "Earlier: List files" }))
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

type Fixture = Effect.Success<ReturnType<typeof agentsFixture>>

const relaunches: ReadonlyArray<{
  readonly program: string
  readonly choice: Pick<NewAgent, "engine" | "model" | "effort">
  readonly replyWithEarlier: (f: Fixture) => Effect.Effect<void>
  readonly hang: (f: Fixture) => Effect.Effect<void>
}> = [
  {
    program: "pi",
    choice: { engine: "pi-cli", model: null, effort: null },
    replyWithEarlier: (f) =>
      f.model.configure({
        output: (input) => `Earlier: ${userMessages(input).slice(0, -1).join(" | ")}`,
      }),
    hang: (f) => f.model.configure({ hang: true }),
  },
  {
    program: "Claude Code",
    choice: claudeCode,
    replyWithEarlier: (f) => f.claude.configure({ reply: [{ text: "Earlier: {earlier}" }] }),
    hang: (f) => f.claude.configure({ hang: true }),
  },
]

for (const { program, choice, replyWithEarlier, hang } of relaunches)
  it.live(
    `marks a running ${program} Turn interrupted after a relaunch, and continues the conversation`,
    () =>
      Effect.gen(function* () {
        const f = yield* agentsFixture({})
        yield* replyWithEarlier(f)
        const agent = yield* f.start("Remember the word lantern", choice)
        yield* f.transcript(agent.id, settled(1))

        yield* hang(f)
        yield* f.send(agent.id, "Keep going")
        yield* f.transcript(agent.id, (turns) => turns.length === 2)

        const restarted = yield* f.restart
        yield* replyWithEarlier(f)
        yield* restarted.SendMessage({
          agentId: agent.id,
          message: "What was the word?",
          images: [],
        })
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
      const f = yield* agentsFixture({}, undefined, {
        reply: [{ text: "Hello from Claude Code." }],
      })

      const connections = yield* droppableHostConnections
      const agent = yield* f.start("First", claudeCode)
      yield* f.transcript(agent.id, settled(1))

      yield* f.claude.configure({
        reply: [{ text: "Written while you were away." }],
        replyDelayMillis: 500,
      })
      yield* f.send(agent.id, "Second")

      yield* f.claude.logged("prompt", 2)
      connections.drop()
      yield* f.claude.logged("replied", 2)
      connections.reconnect()

      const turns = yield* f.transcript(agent.id, settled(2))

      assert.deepStrictEqual(
        turns.map((turn) => ({ parts: turn.parts, ending: turn.ended?.ending })),
        [
          {
            parts: [TextPart.make({ text: "Hello from Claude Code." })],
            ending: TurnDone.make({}),
          },
          {
            parts: [TextPart.make({ text: "Written while you were away." })],
            ending: TurnDone.make({}),
          },
        ],
      )
    }),
)

it.live("cuts off the running Turn when its output can't be saved, and keeps the Agent going", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, { reply: [{ text: "Hello from Claude Code." }] })
    const database = new DatabaseSync(join(f.home, ".project-glass", "glass.db"))

    try {
      database.exec(`
        CREATE TRIGGER refuse_parts BEFORE INSERT ON agent_turn_part
        BEGIN SELECT RAISE(FAIL, 'disk full'); END
      `)
      const agent = yield* f.start("First", claudeCode)
      const [cutOff] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      database.exec("DROP TRIGGER refuse_parts")
      yield* f.send(agent.id, "Second")
      const turns = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(turns[1]?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Hello from Claude Code." }))
    } finally {
      database.close()
    }
  }),
)

const shown = (part: TurnPart) =>
  Predicate.isTagged(part, "ToolCall")
    ? {
        name: part.name,
        summary: part.inputSummary,
        output: part.output,
        status: part.status,
        parent: part.parentToolCallId,
      }
    : part

it.live(
  "streams a Claude Code Agent's thinking, text, and tool calls, nesting a subagent's under its parent",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, {
        reply: [
          { thinking: "I'll delegate the listing." },
          {
            toolCall: {
              id: "task-1",
              name: "Agent",
              input: { description: "List files", prompt: "Run ls" },
              output: "README.md",
            },
          },
          {
            toolCall: {
              id: "bash-1",
              name: "Bash",
              input: { command: "ls" },
              output: "README.md",
              parentToolCallId: "task-1",
            },
          },
          {
            toolCall: {
              id: "bash-2",
              name: "Bash",
              input: { command: "false" },
              output: "exit 1",
              isError: true,
            },
          },
          { text: "There's a **README**." },
        ],
      })

      const agent = yield* f.start("What's here?", claudeCode)
      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.equal(agent.engine, "claude-code")
      assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(turn?.parts.map(shown), [
        ThinkingPart.make({ text: "I'll delegate the listing." }),
        { name: "Agent", summary: "List files", output: "README.md", status: "done", parent: null },
        { name: "Bash", summary: "ls", output: "README.md", status: "done", parent: "task-1" },
        { name: "Bash", summary: "false", output: "exit 1", status: "failed", parent: null },
        TextPart.make({ text: "There's a **README**." }),
      ])

      const launched = (yield* f.claude.log).flatMap((line) =>
        line.kind === "launched" ? [line.cwd] : [],
      )

      assert.deepStrictEqual(launched, [realpathSync(f.worktree(agent.name))])
    }),
)

it.live("fails a Claude Code Turn with a reason that leaves out Claude Code's own words", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({}, undefined, {
      error: { status: 401, message: "sk-ant-secret is not a valid API key" },
    })

    const agent = yield* f.start("Say hello", claudeCode)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    const ending = turn?.ended?.ending
    const reason = Predicate.isTagged(ending, "Failed") ? ending.reason : ""
    assert.include(reason, "sign in")
    assert.notInclude(reason, "sk-ant-secret")
  }),
)

it.live(
  "fails the running Turn when Claude Code exits, and starts it again for the next message",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, { exit: true })
      const agent = yield* f.start("Say hello", claudeCode)

      const [failed] = yield* f.transcript(agent.id, settled(1))
      const ending = failed?.ended?.ending
      assert.include(Predicate.isTagged(ending, "Failed") ? ending.reason : "", "stopped")

      yield* f.claude.configure({ reply: [{ text: "Back again." }] })
      yield* f.send(agent.id, "Try again")
      const [, retried] = yield* f.transcript(agent.id, settled(2))

      assert.deepStrictEqual(retried?.ended?.ending, TurnDone.make({}))
      assert.deepInclude(retried?.parts ?? [], TextPart.make({ text: "Back again." }))
    }),
)

it.live("lists the models and efforts each agent program offers, with its default", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})

    const claude = yield* f.client.ListAgentModels({ engine: "claude-code", place: thisMac })
    assert.equal(claude.defaultModel?.name, "Opus 5.5")
    assert.deepStrictEqual(claude.models, [
      { id: "opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "sonnet", name: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
      { id: "claude-haiku-4-5", name: "Haiku 4.5", efforts: [] },
    ])

    const pi = yield* f.client.ListAgentModels({ engine: "pi-cli", place: thisMac })
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

      const pi = yield* f.client.ListAgentModels({ engine: "pi-cli", place: thisMac })
      assert.equal(pi.defaultModel?.id, "glass-extension/extension-model")
      assert.deepStrictEqual(
        pi.models.map(({ id }) => id),
        ["glass-extension/extension-model", "glass-test/gpt-test-thinking"],
      )
    }),
)

it.live(
  "starts a Claude Code Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, { reply: [{ text: "{model} at {effort}" }] })

      const agent = yield* f.start("Which model?", {
        engine: "claude-code",
        model: "sonnet",
        effort: "high",
      })

      const [first] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(lastText(first), TextPart.make({ text: "sonnet at high" }))

      const changed = yield* f.client.ChangeAgentModel({
        agentId: agent.id,
        model: null,
        effort: null,
      })

      assert.deepStrictEqual(
        { model: changed.model, effort: changed.effort },
        { model: null, effort: null },
      )

      yield* f.send(agent.id, "And now?")
      const [, second] = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(lastText(second), TextPart.make({ text: "default at default" }))
    }),
)

it.live(
  "starts a pi Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Hi." })

      const agent = yield* f.start("Say hello", {
        engine: "pi-cli",
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
    const thinker = { engine: "pi-cli", model: "glass-test/gpt-test-thinking" } as const

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

it.live("streams a long Claude Code reply, a fast burst of events, to its end", () =>
  Effect.gen(function* () {
    const long = "Every word of this reply streams in its own small piece. ".repeat(8).trim()
    const f = yield* agentsFixture({}, undefined, { reply: [{ text: long }] })
    const agent = yield* f.start("Say a lot", claudeCode)
    const [turn] = yield* f.transcript(agent.id, settled(1))

    assert.deepStrictEqual(turn?.ended?.ending, TurnDone.make({}))
    assert.deepStrictEqual(lastText(turn), TextPart.make({ text: long }))
  }),
)

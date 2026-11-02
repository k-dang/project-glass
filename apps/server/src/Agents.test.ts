import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  AgentStarted,
  AllowRequest,
  isRequestPart,
  isWaiting,
  TextPart,
  TextPatch,
  thisMac,
  TOKEN_PARAM,
  type Turn,
  TurnCutOff,
  TurnDone,
  TurnInterrupted,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { Socket } from "effect/socket"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { agentsFixture, lastText, repository, settled } from "../test/agentsFixture"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome, LAUNCH_TOKEN, startSignedInBackend } from "../test/harness"
import { AgentHostRpcs } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"

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
  childProcesses(process.pid, "scriptedAgentHost.mjs").find((pid) => !before.includes(pid))

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
    const f = yield* agentsFixture
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
    const f = yield* agentsFixture
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

const hasWaiting = ({ parts }: Turn) => parts.some(isWaiting)

const holding = (turns: ReadonlyArray<Turn>) =>
  turns.some(({ parts }) =>
    parts.some((part) => Predicate.isTagged(part, "Text") && part.text === "Holding."),
  )

it.live(
  "cuts off the running Turn when the agent host dies, and starts a new host for the next message",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
      const agent = yield* f.start("hold:never")
      yield* f.transcript(agent.id, holding)

      const host = startedHost(earlierHosts)
      assert.isDefined(host, "the backend has no agent host running")
      process.kill(host, "SIGKILL")

      const [cutOff] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

      yield* f.send(agent.id, "Try again")
      const [, again] = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
    }),
)

it.live(
  "retires a Permission request waiting when the agent host dies, and refuses its answer",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
      const agent = yield* f.start("Please ask permission")

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

      yield* f.send(agent.id, "Please ask permission again")
      const [, again] = yield* f.answering(agent.id, settled(2), () => AllowRequest.make({}))
      assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
    }),
)

it.live(
  "removes an Agent's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("hold:never")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, holding)

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
    }),
)

it.live(
  "diffs an Agent's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))

      yield* Effect.promise(async () => {
        await writeFile(join(worktree, "committed.txt"), "done\n")
        gitIn(worktree, "add", "committed.txt")
        gitIn(
          worktree,
          "-c",
          "user.name=Agent",
          "-c",
          "user.email=agent@glass.invalid",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "-m",
          "Commit",
        )
        await writeFile(join(worktree, "staged.txt"), "staged \n")
        gitIn(worktree, "add", "staged.txt")
        await mkdir(join(worktree, "docs dir"))
        await rename(join(worktree, "README.md"), join(worktree, "docs dir", "read é.md"))
        await writeFile(join(worktree, "notes.txt"), "hello\n")
        await writeFile(join(worktree, "logo.bin"), Buffer.from([0, 1]))
      })

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

it.live("marks a running Turn interrupted after a relaunch, and runs the next message", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start("First")
    yield* f.transcript(agent.id, settled(1))

    yield* f.send(agent.id, "hold:never")
    yield* f.transcript(agent.id, holding)

    const restarted = yield* f.restart
    yield* restarted.SendMessage({ agentId: agent.id, message: "Third", images: [] })
    const turns = yield* f.transcript(agent.id, settled(3), restarted)

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending),
      [TurnDone.make({}), TurnInterrupted.make({}), TurnDone.make({})],
    )
    assert.deepStrictEqual(lastText(turns[2]), TextPart.make({ text: "Reply to: Third" }))
  }),
)

it.live(
  "fills in what it missed while it lost its connection to the agent host, repeating nothing",
  () =>
    Effect.gen(function* () {
      const connections = yield* droppableHostConnections

      const f = yield* agentsFixture.pipe(
        Effect.provideService(Socket.WebSocketConstructor, connections.constructor),
      )

      const agent = yield* f.start("First")
      yield* f.transcript(agent.id, settled(1))
      const opened = connections.opened()

      yield* f.send(agent.id, "hold:second")

      const running = yield* f.transcript(
        agent.id,
        (turns) => turns.length === 2 && holding(turns.slice(1)),
      )

      const secondTurnId = running[1]!.id

      yield* connections.drop
      yield* f.release("second")

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
      yield* connections.reconnect

      const turns = yield* f.transcript(agent.id, settled(2))
      assert.isAbove(connections.opened(), opened)

      assert.deepStrictEqual(
        turns.map((turn) => ({ parts: turn.parts, ending: turn.ended?.ending })),
        [
          { parts: [TextPart.make({ text: "Reply to: First" })], ending: TurnDone.make({}) },
          {
            parts: [
              TextPart.make({ text: "Holding." }),
              TextPart.make({ text: "Reply to: hold:second" }),
            ],
            ending: TurnDone.make({}),
          },
        ],
      )
    }),
)

it.live("cuts off the running Turn when its output can't be saved, and keeps the Agent going", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
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
      assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Reply to: Second" }))
    } finally {
      database.close()
    }
  }),
)

import { NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  isRequestPart,
  isWaiting,
  TextPart,
  TOKEN_PARAM,
  type Turn,
  TurnCutOff,
  TurnDone,
  TurnInterrupted,
} from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { Socket } from "effect/socket"
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { agentsFixture, claudeCode, lastText, settled, userMessages } from "../test/agentsFixture"
import { LAUNCH_TOKEN } from "../test/harness"
import { AgentHostRpcs } from "./agentHost/protocol"
import { connectRpcClient } from "./rpcSocket"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

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

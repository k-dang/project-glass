import { NodeFileSystem, NodeSocket } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import {
  AllowRequest,
  isRequestPart,
  isWaiting,
  RPC_PATH,
  TextPart,
  TOKEN_PARAM,
  type Turn,
  TurnCutOff,
  TurnDone,
  TurnInterrupted,
} from "@glass/contracts"
import { Effect, FileSystem, Option, Predicate, Schema, Stream } from "effect"
import { Socket } from "effect/socket"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { conversationsFixture, holding, lastText, settled } from "../test/conversationsFixture"
import { childProcesses, hostExited, startedHost } from "../test/agentHostProcesses"
import { LAUNCH_TOKEN } from "../test/harness"
import {
  HOST_TOKEN_HEADER,
  hostRecordPath,
  readHostRecord,
  RecordedHost,
} from "./agentHost/hostAddress"
import { AgentHostRpcs } from "./agentHost/protocol"
import { greet } from "./hostJournal"
import { connectRpcClient } from "./rpcSocket"

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

const hasWaiting = ({ parts }: Turn) => parts.some(isWaiting)

it.live(
  "retires a Permission request waiting when the agent host dies, and refuses its answer",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
      const conversation = yield* f.start("Please ask permission")

      const [waiting] = yield* f.transcript(conversation.id, (turns) => turns.some(hasWaiting))
      const request = waiting?.parts.find(isWaiting)

      const host = startedHost(earlierHosts)
      assert.isDefined(host, "the backend has no agent host running")
      process.kill(host, "SIGKILL")

      const [cutOff] = yield* f.transcript(conversation.id, settled(1))
      assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))
      assert.equal(cutOff?.parts.find(isRequestPart)?.status, "expired")

      const needsYou = yield* f.client.WatchNeedsYou().pipe(Stream.runHead)
      assert.isFalse(
        Option.getOrThrow(needsYou).some(
          (item) =>
            Predicate.isTagged(item, "Conversation") &&
            item.reasons.some(Predicate.isTagged("WaitingRequests")),
        ),
      )

      const refused = yield* f.client
        .AnswerRequest({
          conversationId: conversation.id,
          requestId: request?.requestId ?? "",
          answer: AllowRequest.make({}),
        })
        .pipe(Effect.flip)

      assert.equal(refused._tag, "RequestNotWaiting")

      yield* f.send(conversation.id, "Please ask permission again")
      const [, again] = yield* f.answering(conversation.id, settled(2), () => AllowRequest.make({}))
      assert.deepStrictEqual(again?.ended?.ending, TurnDone.make({}))
    }),
)

const recordedHost = (home: string) => {
  const dataDirectory = join(home, ".project-glass")

  const read = FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => readHostRecord(fs, hostRecordPath(dataDirectory))),
    Effect.orDie,
    Effect.provide(NodeFileSystem.layer),
  )

  return {
    read,
    fingerprint: (fingerprint: string) =>
      read.pipe(
        Effect.map((recorded) =>
          writeFileSync(
            hostRecordPath(dataDirectory),
            Schema.encodeSync(RecordedHost)({ ...recorded, fingerprint }),
          ),
        ),
      ),
  }
}

const leftHostEnded = (home: string, turnId: string) =>
  Effect.gen(function* () {
    const { port, token } = yield* recordedHost(home).read

    const witness = yield* connectRpcClient(AgentHostRpcs, `ws://127.0.0.1:${port}${RPC_PATH}`, {
      [HOST_TOKEN_HEADER]: token,
    }).pipe(Effect.provide(NodeSocket.layerWebSocketConstructor))

    yield* witness.WatchJournal({ host: yield* greet(witness), after: 0 }).pipe(
      Stream.filter(
        ({ event }) => Predicate.isTagged(event, "TurnEnded") && event.turnId === turnId,
      ),
      Stream.runHead,
    )
  }).pipe(Effect.scoped)

it.live("keeps a running Turn going while Glass is closed, and shows its reply on relaunch", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    const conversation = yield* f.start("First")
    yield* f.transcript(conversation.id, settled(1))

    yield* f.send(conversation.id, "hold:second")

    const running = yield* f.transcript(
      conversation.id,
      (turns) => turns.length === 2 && holding(turns.slice(1)),
    )

    yield* f.quit
    yield* f.release("second")

    yield* leftHostEnded(f.home, running[1]!.id)

    const relaunched = yield* f.launch
    const turns = yield* f.transcript(conversation.id, settled(2), relaunched)

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

it.live("starts a message Queued behind a Turn that ended while Glass was closed", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    const conversation = yield* f.start("hold:first")
    const [running] = yield* f.transcript(conversation.id, holding)
    yield* f.send(conversation.id, "Second")

    yield* f.quit
    yield* f.release("first")
    yield* leftHostEnded(f.home, running!.id)

    const relaunched = yield* f.launch
    const turns = yield* f.transcript(conversation.id, settled(2), relaunched)

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending),
      [TurnDone.make({}), TurnDone.make({})],
    )
    assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Reply to: Second" }))
  }),
)

// Flaky: listing processes through PowerShell returned JSON that failed to parse on Windows; passed on rerun.
// oxlint-disable-next-line vitest/no-disabled-tests
it.skip("marks a running Turn interrupted when an updated Glass relaunches, stopping the old host", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
    const conversation = yield* f.start("First")
    yield* f.transcript(conversation.id, settled(1))

    yield* f.send(conversation.id, "hold:never")
    yield* f.transcript(conversation.id, holding)
    const host = startedHost(earlierHosts)
    assert.isDefined(host, "the backend has no agent host running")

    yield* f.quit
    yield* recordedHost(f.home).fingerprint("an earlier Glass")

    const relaunched = yield* f.launch
    yield* hostExited(host)

    yield* relaunched.SendMessage({
      conversationId: conversation.id,
      message: "Third",
      images: [],
      feedback: [],
    })
    const turns = yield* f.transcript(conversation.id, settled(3), relaunched)

    assert.deepStrictEqual(
      turns.map(({ ended }) => ended?.ending),
      [TurnDone.make({}), TurnInterrupted.make({}), TurnDone.make({})],
    )
    assert.deepStrictEqual(lastText(turns[2]), TextPart.make({ text: "Reply to: Third" }))
  }))

// Flaky: listing processes through PowerShell returned JSON that failed to parse on Windows; passed on rerun.
// oxlint-disable-next-line vitest/no-disabled-tests
it.skip("stops the agent host when Glass quits with no Turn running", () =>
  Effect.gen(function* () {
    const f = yield* conversationsFixture
    const earlierHosts = childProcesses(process.pid, "scriptedAgentHost.mjs")
    const conversation = yield* f.start("First")
    yield* f.transcript(conversation.id, settled(1))
    const host = startedHost(earlierHosts)
    assert.isDefined(host, "the backend has no agent host running")

    yield* f.quit

    yield* hostExited(host)
  }))

it.live(
  "fills in what it missed while it lost its connection to the agent host, repeating nothing",
  () =>
    Effect.gen(function* () {
      const connections = yield* droppableHostConnections

      const f = yield* conversationsFixture.pipe(
        Effect.provideService(Socket.WebSocketConstructor, connections.constructor),
      )

      const conversation = yield* f.start("First")
      yield* f.transcript(conversation.id, settled(1))
      const opened = connections.opened()

      yield* f.send(conversation.id, "hold:second")

      const running = yield* f.transcript(
        conversation.id,
        (turns) => turns.length === 2 && holding(turns.slice(1)),
      )

      const secondTurnId = running[1]!.id

      yield* connections.drop
      yield* f.release("second")

      const witness = yield* connections.witness
      yield* witness.WatchJournal({ host: yield* greet(witness), after: 0 }).pipe(
        Stream.filter(
          ({ conversationId, event }) =>
            conversationId === conversation.id &&
            Predicate.isTagged(event, "TurnEnded") &&
            event.turnId === secondTurnId,
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const beforeReconnect = yield* f.transcript(conversation.id, (turns) => turns.length === 2)
      assert.isNull(beforeReconnect[1]?.ended)
      yield* connections.reconnect

      const turns = yield* f.transcript(conversation.id, settled(2))
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

it.live(
  "cuts off the running Turn when its output can't be saved, and keeps the Conversation going",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
      const database = new DatabaseSync(join(f.home, ".project-glass", "glass.db"))

      try {
        database.exec(`
        CREATE TRIGGER refuse_parts BEFORE INSERT ON conversation_turn_part
        BEGIN SELECT RAISE(FAIL, 'disk full'); END
      `)
        const conversation = yield* f.start("First")
        const [cutOff] = yield* f.transcript(conversation.id, settled(1))
        assert.deepStrictEqual(cutOff?.ended?.ending, TurnCutOff.make({}))

        database.exec("DROP TRIGGER refuse_parts")
        yield* f.send(conversation.id, "Second")
        const turns = yield* f.transcript(conversation.id, settled(2))
        assert.deepStrictEqual(turns[1]?.ended?.ending, TurnDone.make({}))
        assert.deepStrictEqual(lastText(turns[1]), TextPart.make({ text: "Reply to: Second" }))
      } finally {
        database.close()
      }
    }),
)

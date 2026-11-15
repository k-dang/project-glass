import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  AgentError,
  AgentOutcome,
  TurnDone,
  TurnCutOff,
  TurnInterrupted,
  TurnEnded,
  TurnFailed,
  TurnStopped,
  GlobalConversationUpdate,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option, Schema, Scope, Stream } from "effect"
import { eventually } from "../test/eventually"
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import { migrationLoader } from "./Migrations"
import type { HostClient } from "./Placement"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"
import { HostAgentError } from "./agentHost/protocol"

interface Script {
  readonly ensureStarted?: Conversation["ensureStarted"]
  readonly startTurn?: (turnId: string) => Effect.Effect<void, HostAgentError>
  readonly stopTurn?: () => Effect.Effect<null>
  readonly running?: boolean
}

// SAFETY: these tests call only `StartTurn` and `StopTurn` on the host.
/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above. */
const hostThatStarts = (record: (turnId: string) => Effect.Effect<void, HostAgentError>) =>
  ({
    StartTurn: ({ turnId }: { turnId: string }) => record(turnId),
  }) as unknown as HostClient

const scriptedHost = (
  script: Script,
  dispatched: Array<{ agentId: string; turnId: string }>,
) =>
  ({
    StartTurn: ({ agentId, turnId }: { agentId: string; turnId: string }) =>
      (script.startTurn?.(turnId) ?? Effect.void).pipe(
        Effect.tap(() => Effect.sync(() => dispatched.push({ agentId, turnId }))),
      ),
    StopTurn: () => script.stopTurn?.() ?? Effect.succeed(null),
  }) as unknown as HostClient
/* oxlint-enable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions */

const layer = ConversationTurns.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provideMerge(Layer.mock(ToDos)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const UnitLine = Schema.Struct({ event: Schema.String, delivery: Schema.optional(Schema.String) })

const decodeLine = Schema.decodeUnknownSync(Schema.fromJsonString(UnitLine))

const sent = (message: string) => ({ message, images: [], context: null })

const globalConversationUpdate = GlobalConversationUpdate.make({
  work: [
    AgentOutcome.make({
      agentId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const harness = (
  ensureStarted: Conversation["ensureStarted"],
  startTurn: (turnId: string) => Effect.Effect<void, HostAgentError> = () => Effect.void,
) =>
  Effect.gen(function* () {
    const turns = yield* ConversationTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<string> = []
    const deliveries: Array<string | undefined> = []

    const client = hostThatStarts((turnId) =>
      startTurn(turnId).pipe(Effect.tap(() => Effect.sync(() => dispatched.push(turnId)))),
    )

    const conversation: Conversation = {
      id: "agent-1",
      ensureStarted,
      settings: { model: null, effort: null, permissionMode: null },
      host: Effect.succeed(client),
      runningHost: Effect.succeedNone,
    }

    yield* turns
      .serve({
        claim: () => Effect.succeed(Option.some(conversation)),
        lost: Stream.empty,
        interrupted: Effect.succeed(["agent-1"]),
      })
      .pipe(
        Effect.provide(
          wideEvents("backend", (line) => {
            const { event, delivery } = decodeLine(line)

            if (event === "ConversationTurns.deliver") deliveries.push(delivery)
          }),
        ),
      )

    const delivered = (count: number) =>
      eventually(Effect.sync(() => assert.lengthOf(deliveries, count))).pipe(Effect.as(deliveries))

    const transcript = transcripts.read("agent-1")

    return { turns, conversation, dispatched, transcript, delivered }
  })

const scripted = (scripts: { readonly [id: string]: Script }) =>
  Effect.gen(function* () {
    const turns = yield* ConversationTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<{ agentId: string; turnId: string }> = []
    const conversations = new Map<string, Conversation>()

    for (const [id, script] of Object.entries(scripts)) {
      const client = scriptedHost(script, dispatched)

      conversations.set(id, {
        id,
        ensureStarted: script.ensureStarted ?? (() => Effect.void),
        settings: { model: null, effort: null, permissionMode: null },
        host: Effect.succeed(client),
        runningHost: script.running ? Effect.succeed(Option.some(client)) : Effect.succeedNone,
      })
    }

    yield* turns
      .serve({
        claim: (id) =>
          Effect.sync(() => {
            const conversation = conversations.get(id)

            return conversation === undefined ? Option.none() : Option.some(conversation)
          }),
        lost: Stream.empty,
        interrupted: Effect.succeed(Object.keys(scripts)),
      })
      .pipe(
        Effect.provide(
          wideEvents("backend", (line) => {
            decodeLine(line)
          }),
        ),
      )

    const started = (agentId: string) => dispatched.filter((call) => call.agentId === agentId)

    return { turns, transcripts, conversations, started }
  })

const hold =
  (entered: Deferred.Deferred<void>, release: Deferred.Deferred<void>) => () =>
    Effect.gen(function* () {
      yield* Deferred.succeed(entered, undefined)
      yield* Deferred.await(release)
    })

it.live("ends a Turn stopped before its program starts without ever dispatching it", () =>
  Effect.gen(function* () {
    const gate = yield* Deferred.make<void>()
    const h = yield* harness(() => Deferred.await(gate))

    yield* h.turns.send("agent-1", sent("Build it"))
    yield* h.turns.stop(h.conversation)
    yield* Deferred.succeed(gate, undefined)

    assert.deepStrictEqual(yield* h.delivered(1), ["superseded"])
    assert.deepStrictEqual(h.dispatched, [])

    const { turns } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnStopped.make({}))
  }).pipe(Effect.provide(layer)),
)

it.live("fails a Turn whose program won't start, then starts the next queued message", () =>
  Effect.gen(function* () {
    let starts = 0

    const h = yield* harness(() =>
      ++starts === 1 ? Effect.fail(new AgentError({ message: "No such folder" })) : Effect.void,
    )

    yield* h.turns.send("agent-1", sent("First"))
    yield* h.turns.send("agent-1", sent("Second"))

    assert.deepStrictEqual(yield* h.delivered(2), ["failed", "dispatched"])
    assert.lengthOf(h.dispatched, 1)

    const { turns } = yield* h.transcript
    assert.deepStrictEqual(turns[0]?.ended?.ending, TurnFailed.make({ reason: "No such folder" }))
    assert.equal(turns[1]?.id, h.dispatched[0])
  }).pipe(Effect.provide(layer)),
)

it.live(
  "recovers the same saved Global conversation update before advancing Queued messages, and leaves a completed Global conversation update alone",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts

      let savedId = ""

      // No delivery subscriber exists when the transaction commits, as in a crash before dispatch.
      yield* transcripts.startGlobalConversationUpdate(
        "agent-1",
        globalConversationUpdate,
        (turnId) =>
          Effect.sync(() => {
            savedId = turnId
          }),
      )
      yield* transcripts.startOrQueue("agent-1", sent("After"))
      const firstScope = yield* Scope.make()
      const first = yield* harness(() => Effect.void).pipe(Scope.provide(firstScope))

      assert.deepStrictEqual(yield* first.delivered(1), ["dispatched"])
      assert.deepStrictEqual(first.dispatched, [savedId])

      yield* transcripts.save("agent-1", [
        TurnEnded.make({
          turnId: savedId,
          ended: { at: yield* DateTime.now, ending: TurnDone.make({}) },
        }),
      ])
      yield* first.delivered(2)
      yield* Scope.close(firstScope, Exit.void)

      const second = yield* harness(() => Effect.void)
      const { turns } = yield* second.transcript

      assert.lengthOf(turns, 2)
      assert.equal(turns[0]?.id, savedId)
      assert.deepStrictEqual(turns[0]?.ended?.ending, TurnDone.make({}))
      assert.deepStrictEqual(second.dispatched, [])
    }).pipe(Effect.provide(layer)),
)

it.live(
  "keeps a Global conversation update pending after a recovery read fails, then retries the same Turn on restart",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* transcripts.startGlobalConversationUpdate(
        "agent-1",
        globalConversationUpdate,
        () => Effect.void,
      )
      const savedId = yield* transcripts.runningTurn("agent-1")
      yield* transcripts.startOrQueue("agent-1", sent("After"))
      const firstScope = yield* Scope.make()
      const reason = "Couldn't recover pi's Global conversation update. Restart Glass to try again."

      const first = yield* harness(
        () => Effect.void,
        () => Effect.fail(new HostAgentError({ message: reason })),
      ).pipe(Scope.provide(firstScope))

      assert.deepStrictEqual(yield* first.delivered(1), ["pending"])
      const waiting = yield* first.transcript
      assert.equal(waiting.turns[0]?.ended, null)
      assert.equal(waiting.status, reason)
      assert.lengthOf(waiting.queued, 1)
      yield* transcripts.endRunning(TurnCutOff.make({}), ["agent-1"])
      yield* transcripts.endRunning(TurnInterrupted.make({}), ["agent-1"])
      assert.equal((yield* first.transcript).turns[0]?.ended, null)
      yield* Scope.close(firstScope, Exit.void)

      const second = yield* harness(() => Effect.void)
      assert.deepStrictEqual(yield* second.delivered(1), ["dispatched"])
      assert.deepStrictEqual(second.dispatched, [savedId])
      const recovered = yield* second.transcript
      assert.lengthOf(recovered.turns, 1)
      assert.equal(recovered.turns[0]?.id, savedId)
    }).pipe(Effect.provide(layer)),
)

const forkSend = <A, E, R>(sending: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    let delivery: A | undefined

    const fiber = yield* Effect.forkChild(
      sending.pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            delivery = result
          }),
        ),
      ),
    )

    return { fiber, delivery: () => delivery }
  })

it.live("accepts and dispatches another Agent's message while StartTurn is still unanswered", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const desk = yield* scripted({
      "agent-a": { startTurn: hold(entered, release) },
      "agent-b": {},
    })

    yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host")))
    yield* Deferred.await(entered)
    const other = yield* forkSend(desk.turns.send("agent-b", sent("Hello from B")))
    yield* eventually(
      Effect.sync(() => {
        assert.equal(other.delivery(), "started")
        assert.lengthOf(desk.started("agent-b"), 1)
        assert.lengthOf(desk.started("agent-a"), 0)
      }),
    )
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(other.fiber)
    yield* eventually(Effect.sync(() => assert.lengthOf(desk.started("agent-a"), 1)))
  }).pipe(Effect.provide(layer)),
)

it.live("accepts and dispatches another Agent's message while StopTurn is still unanswered", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>()
    const release = yield* Deferred.make<void>()
    const desk = yield* scripted({
      "agent-a": {
        running: true,
        stopTurn: () => hold(entered, release)().pipe(Effect.as(null)),
      },
      "agent-b": {},
    })
    const agent = desk.conversations.get("agent-a")
    assert.isDefined(agent)

    yield* desk.turns.send("agent-a", sent("Working"))
    yield* eventually(Effect.sync(() => assert.lengthOf(desk.started("agent-a"), 1)))

    const stopping = yield* Effect.forkChild(desk.turns.stop(agent))
    yield* Deferred.await(entered)

    const other = yield* forkSend(desk.turns.send("agent-b", sent("Hello from B")))
    yield* eventually(
      Effect.sync(() => {
        assert.equal(other.delivery(), "started")
        assert.lengthOf(desk.started("agent-b"), 1)
      }),
    )
    yield* Deferred.succeed(release, undefined)
    yield* Fiber.join(stopping)
    yield* Fiber.join(other.fiber)
  }).pipe(Effect.provide(layer)),
)

it.live(
  "accepts and dispatches the Global conversation while an Agent's StartTurn is still unanswered",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release) },
        "global-session": {},
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host")))
      yield* Deferred.await(entered)
      const separate = yield* forkSend(desk.turns.send("global-session", sent("Ask from anywhere")))
      yield* eventually(
        Effect.sync(() => {
          assert.equal(separate.delivery(), "started")
          assert.lengthOf(desk.started("global-session"), 1)
          assert.lengthOf(desk.started("agent-a"), 0)
        }),
      )
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(separate.fiber)
      yield* eventually(Effect.sync(() => assert.lengthOf(desk.started("agent-a"), 1)))
    }).pipe(Effect.provide(layer)),
)

it.live(
  "runs idle work and a queued send for other conversations while StartTurn is still unanswered",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let idle = false
      let update = false
      let sentQueued = false
      const desk = yield* scripted({
        "agent-a": { startTurn: hold(entered, release) },
        "agent-c": {},
        "global-session": {},
      })

      yield* Effect.forkChild(desk.turns.send("agent-a", sent("Hold the host")))
      yield* Deferred.await(entered)
      yield* Effect.forkChild(
        desk.turns.whileIdle(
          "agent-c",
          Effect.sync(() => {
            idle = true
          }),
        ),
      )
      yield* Effect.forkChild(
        desk.turns.whenIdle("global-session", () =>
          Effect.sync(() => {
            update = true
          }),
        ),
      )
      yield* Effect.forkChild(
        desk.turns.sendQueued("agent-c", "absent").pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              sentQueued = true
            }),
          ),
        ),
      )
      yield* eventually(
        Effect.sync(() => {
          assert.isTrue(idle)
          assert.isTrue(update)
          assert.isTrue(sentQueued)
          assert.lengthOf(desk.started("agent-a"), 0)
        }),
      )
      yield* Deferred.succeed(release, undefined)
    }).pipe(Effect.provide(layer)),
)

it.live("dispatches a Queued message sent after the running Turn stops", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)

    yield* h.turns.send("agent-1", sent("First"))
    assert.deepStrictEqual(yield* h.delivered(1), ["dispatched"])
    yield* h.turns.send("agent-1", sent("Second"))

    const queued = (yield* h.transcript).queued[0]
    assert.isDefined(queued)
    yield* h.turns.stop(h.conversation)

    const stopped = yield* h.transcript
    assert.deepStrictEqual(stopped.turns[0]?.ended?.ending, TurnStopped.make({}))
    assert.lengthOf(stopped.queued, 1)
    yield* h.turns.sendQueued("agent-1", queued.id)
    assert.deepStrictEqual(yield* h.delivered(2), ["dispatched", "dispatched"])
    assert.lengthOf((yield* h.transcript).queued, 0)
    assert.equal((yield* h.transcript).turns[1]?.id, h.dispatched[1])
  }).pipe(Effect.provide(layer)),
)

it.live("starts an idle update only while that conversation has nothing running or Queued", () =>
  Effect.gen(function* () {
    const h = yield* harness(() => Effect.void)
    let started = 0

    yield* h.turns.whenIdle("agent-1", (start) =>
      start(globalConversationUpdate, () =>
        Effect.sync(() => {
          started += 1
        }),
      ),
    )
    assert.equal(started, 1)
    yield* h.delivered(1)

    let again = false
    yield* h.turns.whenIdle("agent-1", () =>
      Effect.sync(() => {
        again = true
      }),
    )
    assert.isFalse(again)
    assert.equal((yield* h.transcript).turns[0]?.context?._tag, "GlobalConversationUpdate")
  }).pipe(Effect.provide(layer)),
)

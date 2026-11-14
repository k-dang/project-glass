import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  AgentError,
  AgentReported,
  TurnDone,
  TurnCutOff,
  TurnInterrupted,
  TurnEnded,
  TurnFailed,
  TurnStopped,
  WorkReport,
} from "@glass/contracts"
import { DateTime, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import { eventually } from "../test/eventually"
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import { migrationLoader } from "./Migrations"
import type { HostClient } from "./Placement"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"
import { HostAgentError } from "./agentHost/protocol"

// SAFETY: a delivery calls only `StartTurn` on its host.
/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above. */
const hostThatStarts = (record: (turnId: string) => Effect.Effect<void, HostAgentError>) =>
  ({
    StartTurn: ({ turnId }: { turnId: string }) => record(turnId),
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

const report = WorkReport.make({
  work: [
    AgentReported.make({
      agentId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const harness = (
  start: Conversation["start"],
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
      start,
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
  "recovers the same saved Report before advancing Queued messages, and leaves a completed Report alone",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts

      let savedId = ""

      // No delivery subscriber exists when the transaction commits, as in a crash before dispatch.
      yield* transcripts.startReport("agent-1", report, (turnId) =>
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
  "keeps a Report pending after a recovery read fails, then retries the same Turn on restart",
  () =>
    Effect.gen(function* () {
      const transcripts = yield* Transcripts
      yield* transcripts.startReport("agent-1", report, () => Effect.void)
      const savedId = yield* transcripts.runningTurn("agent-1")
      yield* transcripts.startOrQueue("agent-1", sent("After"))
      const firstScope = yield* Scope.make()
      const reason = "Couldn't recover pi's Report. Restart Glass to try again."

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

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { AgentError, TurnFailed, TurnStopped } from "@glass/contracts"
import { Deferred, Effect, Layer, Option, Schema, Stream } from "effect"
import { eventually } from "../test/eventually"
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import { migrationLoader } from "./Migrations"
import type { HostClient } from "./Placement"
import { ToDos } from "./ToDos"
import { Transcripts } from "./Transcripts"
import { wideEvents } from "./wideEvents"

// SAFETY: a delivery calls only `StartTurn` on its host.
/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- See SAFETY above. */
const hostThatStarts = (record: (turnId: string) => void) =>
  ({
    StartTurn: ({ turnId }: { turnId: string }) => Effect.sync(() => record(turnId)),
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

const harness = (start: Conversation["start"]) =>
  Effect.gen(function* () {
    const turns = yield* ConversationTurns
    const transcripts = yield* Transcripts
    const dispatched: Array<string> = []
    const deliveries: Array<string | undefined> = []

    const client = hostThatStarts((turnId) => dispatched.push(turnId))

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
        interrupted: Effect.succeed([]),
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

import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { ThreadError, ThreadOutcome, StartedWorkUpdate } from "@glass/contracts"
import { DateTime, Effect, Layer, Stream, Option } from "effect"
import { SqlClient } from "effect/sql"
import { Threads } from "./Threads"
import { AgentReviews } from "./AgentReviews"
import { migrationLoader } from "./Migrations"
import { StartedWork } from "./StartedWork"
import { Transcripts } from "./Transcripts"

const layer = StartedWork.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provide(Layer.mock(Threads)({ harnesses: () => ["pi"], markTurnSeen: () => Effect.void })),
  Layer.provide(Layer.mock(AgentReviews)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const at = DateTime.makeUnsafe("2026-11-14T12:00:00Z")

const startedWorkUpdate = StartedWorkUpdate.make({
  work: [
    ThreadOutcome.make({
      threadId: "started",
      name: "Started",
      askedWith: "Build it",
      outcome: "finished",
      reason: null,
    }),
  ],
})

const startedWorkUpdateTurn = {
  message: "",
  images: [],
  context: startedWorkUpdate,
  retriesDelivery: true,
}

it.live(
  "commits the Started work update and its covered outcomes together, publishing only after commit",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const started = yield* StartedWork
      yield* sql`INSERT INTO started_thread (started_by, thread_id, started_at)
      VALUES ('global', 'started', ${DateTime.formatIso(at)})`
      const published = yield* transcripts.subscribeStarted

      const record = (turnId: string) =>
        started.recordStartedWorkUpdate("global", turnId, [{ work: startedWorkUpdate.work[0], at }])

      const failed = yield* Effect.exit(
        transcripts.startIfIdle("session", startedWorkUpdateTurn, (turnId) =>
          record(turnId).pipe(Effect.andThen(new ThreadError({ message: "Crash before commit" }))),
        ),
      )

      assert.equal(failed._tag, "Failure")
      assert.deepStrictEqual(
        yield* sql`SELECT started_work_update_outcome_at, started_work_update_turn_id FROM started_thread`,
        [{ started_work_update_outcome_at: null, started_work_update_turn_id: null }],
      )
      assert.deepStrictEqual((yield* transcripts.read("session")).turns, [])

      yield* transcripts.startIfIdle("session", startedWorkUpdateTurn, record)
      const event = yield* published.pipe(Stream.runHead)
      const [turn] = (yield* transcripts.read("session")).turns
      assert.isDefined(turn)
      assert.equal(Option.getOrThrow(event).turnId, turn.id)
      assert.deepStrictEqual(
        yield* sql`SELECT started_work_update_outcome_at, started_work_update_turn_id FROM started_thread`,
        [
          {
            started_work_update_outcome_at: DateTime.formatIso(at),
            started_work_update_turn_id: turn.id,
          },
        ],
      )
    }).pipe(Effect.provide(layer)),
)

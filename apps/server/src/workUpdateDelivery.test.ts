import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { AgentError, AgentOutcome, WorkUpdate } from "@glass/contracts"
import { DateTime, Effect, Layer, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { Agents } from "./Agents"
import { AgentReviews } from "./AgentReviews"
import { migrationLoader } from "./Migrations"
import { StartedWork } from "./StartedWork"
import { Transcripts } from "./Transcripts"

const layer = StartedWork.layer.pipe(
  Layer.provideMerge(Transcripts.layer),
  Layer.provide(Layer.mock(Agents)({ engines: () => ["pi"], markTurnSeen: () => Effect.void })),
  Layer.provide(Layer.mock(AgentReviews)({})),
  Layer.provideMerge(SqliteMigrator.layer({ loader: migrationLoader })),
  Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })),
)

const at = DateTime.makeUnsafe("2026-11-14T12:00:00Z")

const workUpdate = WorkUpdate.make({
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

it.live(
  "commits the Work update and its covered outcomes together, publishing only after commit",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const started = yield* StartedWork
      yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at)
      VALUES ('global', 'started', ${DateTime.formatIso(at)})`
      const published = yield* transcripts.subscribeStarted

      const record = (turnId: string) =>
        started.recordWorkUpdate("global", turnId, [{ work: workUpdate.work[0], at }])

      const failed = yield* Effect.exit(
        transcripts.startWorkUpdate("session", workUpdate, (turnId) =>
          record(turnId).pipe(Effect.andThen(new AgentError({ message: "Crash before commit" }))),
        ),
      )

      assert.equal(failed._tag, "Failure")
      assert.deepStrictEqual(
        yield* sql`SELECT work_update_outcome_at, work_update_turn_id FROM conversation_agent`,
        [{ work_update_outcome_at: null, work_update_turn_id: null }],
      )
      assert.deepStrictEqual((yield* transcripts.read("session")).turns, [])

      yield* transcripts.startWorkUpdate("session", workUpdate, record)
      const event = yield* published.pipe(Stream.runHead)
      assert.equal(event._tag, "Some")
      const [turn] = (yield* transcripts.read("session")).turns
      assert.isDefined(turn)
      assert.deepStrictEqual(
        yield* sql`SELECT work_update_outcome_at, work_update_turn_id FROM conversation_agent`,
        [{ work_update_outcome_at: DateTime.formatIso(at), work_update_turn_id: turn.id }],
      )
    }).pipe(Effect.provide(layer)),
)

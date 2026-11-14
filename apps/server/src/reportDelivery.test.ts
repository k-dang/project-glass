import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { AgentError, AgentReported, WorkReport } from "@glass/contracts"
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

it.live("commits the Report and its covered outcomes together, publishing only after commit", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const transcripts = yield* Transcripts
    const started = yield* StartedWork
    yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at)
      VALUES ('global', 'started', ${DateTime.formatIso(at)})`
    const published = yield* transcripts.subscribeStarted

    const record = (turnId: string) =>
      started.recordReport("global", turnId, [{ work: report.work[0], at }])

    const failed = yield* Effect.exit(
      transcripts.startReport("session", report, (turnId) =>
        record(turnId).pipe(Effect.andThen(new AgentError({ message: "Crash before commit" }))),
      ),
    )

    assert.equal(failed._tag, "Failure")
    assert.deepStrictEqual(yield* sql`SELECT reported_at, report_turn_id FROM conversation_agent`, [
      { reported_at: null, report_turn_id: null },
    ])
    assert.deepStrictEqual((yield* transcripts.read("session")).turns, [])

    yield* transcripts.startReport("session", report, record)
    const event = yield* published.pipe(Stream.runHead)
    assert.equal(event._tag, "Some")
    const [turn] = (yield* transcripts.read("session")).turns
    assert.isDefined(turn)
    assert.deepStrictEqual(yield* sql`SELECT reported_at, report_turn_id FROM conversation_agent`, [
      { reported_at: DateTime.formatIso(at), report_turn_id: turn.id },
    ])
  }).pipe(Effect.provide(layer)),
)

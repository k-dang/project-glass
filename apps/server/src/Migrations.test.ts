import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { TurnDone, TurnEnd } from "@glass/contracts"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { isolatedHome } from "../test/harness"
import baseline from "./migrations/0001_baseline"
import agentReviewHotspots from "./migrations/0002_agent_review_hotspots"
import agentReviewDone from "./migrations/0003_agent_review_done"
import outsideAgent from "./migrations/0004_outside_agent"
import conversationStartedWork from "./migrations/0005_conversation_started_work"
import turnSeen from "./migrations/0006_turn_seen"
import workReports from "./migrations/0007_work_reports"
import { migrationLoader } from "./Migrations"

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

it.live("creates the schema once and reads Activity through its indexes after reopening", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const filename = join(home, "glass.db")

    for (const expected of [
      [
        [1, "baseline"],
        [2, "agent_review_hotspots"],
        [3, "agent_review_done"],
        [4, "outside_agent"],
        [5, "conversation_started_work"],
        [6, "turn_seen"],
        [7, "work_reports"],
        [8, "past_global_conversations"],
        [9, "report_delivery"],
      ],
      [],
    ] as const) {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        assert.deepStrictEqual(yield* SqliteMigrator.run({ loader: migrationLoader }), expected)

        const plan = yield* sql<{ detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT DISTINCT json_extract(payload, '$.pullRequest.ref') AS ref
          FROM activity
          WHERE lower(login) = lower(${"kevin"})
            AND json_extract(payload, '$.pullRequest.ref') IS NOT NULL
        `

        assert.isTrue(
          plan.some(({ detail }) => detail.includes("USING COVERING INDEX activity_login_pr")),
        )

        const newestFirst = yield* sql<{ detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT id, occurred_at, payload FROM activity
          WHERE lower(login) = lower(${"kevin"})
          ORDER BY id DESC
          LIMIT 1
        `

        assert.deepStrictEqual(
          newestFirst.map(({ detail }) => detail),
          ["SEARCH activity USING INDEX activity_login_id (<expr>=?)"],
        )

        const stamps = yield* sql<{ detail: string }>`
          EXPLAIN QUERY PLAN
          SELECT kind, occurred_at FROM activity
          WHERE lower(login) = lower(${"kevin"})
            AND occurred_at >= ${"2026-10-20T00:00:00Z"}
            AND kind IN ('ReplySent', 'ToDoDone')
        `

        assert.isTrue(
          stamps.some(({ detail }) =>
            detail.includes("USING COVERING INDEX activity_login_kind_time"),
          ),
        )
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)
    }
  }),
)

it.live("keeps Agent reviews written before hotspots, with none", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "0001_baseline": baseline }),
      })
      yield* sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown)
        VALUES ('octo-org', 'hello-world', 1, 'b', 'h', '2026-11-11T00:00:00Z', 'Looks fine.')`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(
        yield* sql`SELECT markdown, hotspots, low_attention FROM agent_reviews`,
        [{ markdown: "Looks fine.", hotspots: "[]", low_attention: "[]" }],
      )
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("counts the Turns that ended before Turns could be seen as seen", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "0001_baseline": baseline,
          "0002_agent_review_hotspots": agentReviewHotspots,
          "0003_agent_review_done": agentReviewDone,
          "0004_outside_agent": outsideAgent,
          "0005_conversation_started_work": conversationStartedWork,
        }),
      })

      for (const id of ["worked", "fresh"])
        yield* sql`INSERT INTO agent (id, name, owner, repo, base_branch, engine, folder, created_at)
          VALUES (${id}, ${id}, 'glass-demo', 'greeter', 'main', 'pi', ${id}, '2026-11-11T00:00:00.000Z')`

      for (const [id, at] of [
        ["first", "2026-11-11T01:00:00.000Z"],
        ["second", "2026-11-11T02:00:00.000Z"],
      ] as const)
        yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, ended)
          VALUES (${id}, 'worked', 'Say hello', '2026-11-11T00:00:00.000Z',
            ${encodeEnd({ at: DateTime.makeUnsafe(at), ending: TurnDone.make({}) })})`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(yield* sql`SELECT id, turn_seen_at FROM agent ORDER BY id`, [
        { id: "fresh", turn_seen_at: null },
        { id: "worked", turn_seen_at: "2026-11-11T02:00:00.000Z" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("counts work the Global conversation started before reports as reported", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "0001_baseline": baseline,
          "0002_agent_review_hotspots": agentReviewHotspots,
          "0003_agent_review_done": agentReviewDone,
          "0004_outside_agent": outsideAgent,
          "0005_conversation_started_work": conversationStartedWork,
          "0006_turn_seen": turnSeen,
        }),
      })

      yield* sql`INSERT INTO global_conversation (id) VALUES ('global')`
      yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, ended)
        VALUES ('asked', 'global', 'Review #7', '2026-11-11T00:00:00.000Z',
          ${encodeEnd({ at: DateTime.makeUnsafe("2026-11-11T01:00:00.000Z"), ending: TurnDone.make({}) })})`
      yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at)
        VALUES ('global', 'agent', '2026-11-11T00:00:00.000Z')`
      yield* sql`INSERT INTO conversation_agent_review (conversation_id, owner, repo, number, started_at)
        VALUES ('global', 'glass-demo', 'greeter', 7, '2026-11-11T00:00:00.000Z')`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      const [agent] = yield* sql<{
        reported_at: string
      }>`SELECT reported_at FROM conversation_agent`

      const [review] = yield* sql<{
        reported_at: string
      }>`SELECT reported_at FROM conversation_agent_review`

      assert.isTrue(agent!.reported_at > "2026-11-11T01:00:00.000Z")
      assert.isTrue(review!.reported_at > "2026-11-11T01:00:00.000Z")
      assert.deepStrictEqual(yield* sql`SELECT turn_seen_at FROM global_conversation`, [
        { turn_seen_at: "2026-11-11T01:00:00.000Z" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("keeps the Global conversation's pi session, started at its first Turn", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({
          "0001_baseline": baseline,
          "0002_agent_review_hotspots": agentReviewHotspots,
          "0003_agent_review_done": agentReviewDone,
          "0004_outside_agent": outsideAgent,
          "0005_conversation_started_work": conversationStartedWork,
          "0006_turn_seen": turnSeen,
          "0007_work_reports": workReports,
        }),
      })

      yield* sql`INSERT INTO global_conversation (id) VALUES ('global')`

      for (const [id, at] of [
        ["second", "2026-11-11T02:00:00.000Z"],
        ["first", "2026-11-11T01:00:00.000Z"],
      ] as const)
        yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at)
          VALUES (${id}, 'global', 'Say hello', ${at})`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(
        yield* sql`SELECT session_id, session_started_at FROM global_conversation`,
        [{ session_id: "global", session_started_at: "2026-11-11T01:00:00.000Z" }],
      )
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

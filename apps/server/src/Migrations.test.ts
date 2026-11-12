import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { isolatedHome } from "../test/harness"
import baseline from "./migrations/0001_baseline"
import { migrationLoader } from "./Migrations"

it.live("creates the schema once and reads Activity through its indexes after reopening", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const filename = join(home, "glass.db")

    for (const expected of [
      [
        [1, "baseline"],
        [2, "agent_review_hotspots"],
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

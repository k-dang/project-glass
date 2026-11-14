import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import { AgentOutcome, TurnDone, TurnEnd, GlobalConversationUpdate } from "@glass/contracts"
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
import pastGlobalConversations from "./migrations/0008_past_global_conversations"
import { migrationLoader } from "./Migrations"
import { Transcripts } from "./Transcripts"

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

it.live("upgrades main's schema directly, preserving completed and unfinished updates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const previousMigrations = {
      "0001_baseline": baseline,
      "0002_agent_review_hotspots": agentReviewHotspots,
      "0003_agent_review_done": agentReviewDone,
      "0004_outside_agent": outsideAgent,
      "0005_conversation_started_work": conversationStartedWork,
      "0006_turn_seen": turnSeen,
      "0007_work_reports": workReports,
      "0008_past_global_conversations": pastGlobalConversations,
    }

    yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(previousMigrations) })

    const at = "2026-11-14T12:00:00.000Z"

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

    const context = JSON.stringify(globalConversationUpdate).replace(
      '"_tag":"GlobalConversationUpdate"',
      '"_tag":"Report"',
    )

    const ended = encodeEnd({ at: DateTime.makeUnsafe(at), ending: TurnDone.make({}) })

    yield* sql`INSERT INTO global_conversation (id) VALUES ('global')`

    for (const [id, end] of [
      ["pending", null],
      ["completed", ended],
    ] as const)
      yield* sql`INSERT INTO agent_turn (id, agent_id, message, context, sent_at, ended)
        VALUES (${id}, 'global', '', ${context}, ${at}, ${end})`
    yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, ended)
      VALUES ('ordinary', 'global', 'Report a bug', ${at}, ${ended})`
    yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at, reported_at)
      VALUES ('global', 'started', ${at}, ${at})`
    yield* sql`INSERT INTO conversation_agent_review (conversation_id, owner, repo, number, started_at, reported_at)
      VALUES ('global', 'glass-demo', 'greeter', 7, ${at}, ${at})`
    yield* sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, reported)
      VALUES ('glass-demo', 'greeter', 7, 'b', 'h', ${at}, 'Looks fine.', 1)`

    assert.deepStrictEqual(yield* SqliteMigrator.run({ loader: migrationLoader }), [
      [9, "global_conversation_updates"],
    ])
    const transcripts = yield* Transcripts
    const { turns } = yield* transcripts.read("global")
    assert.deepStrictEqual(
      turns.filter((turn) => turn.id !== "ordinary").map((turn) => turn.context),
      [globalConversationUpdate, globalConversationUpdate],
    )
    assert.equal(turns.find((turn) => turn.id === "ordinary")?.message, "Report a bug")
    assert.deepStrictEqual(
      (yield* transcripts.recoverGlobalConversationUpdates(["global"])).map((turn) => turn.turnId),
      ["pending"],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT global_conversation_update_outcome_at, global_conversation_update_turn_id FROM conversation_agent`,
      [
        {
          global_conversation_update_outcome_at: at,
          global_conversation_update_turn_id: null,
        },
      ],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT global_conversation_update_outcome_at, global_conversation_update_turn_id FROM conversation_agent_review`,
      [
        {
          global_conversation_update_outcome_at: at,
          global_conversation_update_turn_id: null,
        },
      ],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT included_in_global_conversation_update, done FROM agent_reviews`,
      [{ included_in_global_conversation_update: 1, done: 0 }],
    )
    yield* sql`UPDATE conversation_agent_review SET global_conversation_update_turn_id = 'completed'`
    yield* sql`DELETE FROM agent_turn WHERE id = 'completed'`
    assert.deepStrictEqual(
      yield* sql`SELECT global_conversation_update_turn_id FROM conversation_agent_review`,
      [{ global_conversation_update_turn_id: null }],
    )
  }).pipe(
    Effect.provide(Transcripts.layer),
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.scoped,
  ),
)

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
        [9, "global_conversation_updates"],
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

it.live(
  "counts pre-existing work as already included when Global conversation updates are introduced",
  () =>
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
          global_conversation_update_outcome_at: string
        }>`SELECT global_conversation_update_outcome_at FROM conversation_agent`

        const [review] = yield* sql<{
          global_conversation_update_outcome_at: string
        }>`SELECT global_conversation_update_outcome_at FROM conversation_agent_review`

        assert.isTrue(agent!.global_conversation_update_outcome_at > "2026-11-11T01:00:00.000Z")
        assert.isTrue(review!.global_conversation_update_outcome_at > "2026-11-11T01:00:00.000Z")
        assert.deepStrictEqual(yield* sql`SELECT turn_seen_at FROM global_conversation`, [
          { turn_seen_at: "2026-11-11T01:00:00.000Z" },
        ])
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
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

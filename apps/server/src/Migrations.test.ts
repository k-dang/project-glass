import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  ConversationContext,
  ConversationOutcome,
  LineNote,
  StartedWorkUpdate,
  SteerPart,
  TurnDone,
  TurnEnd,
  UnsentFeedback,
} from "@glass/contracts"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { isolatedHome } from "../test/harness"
import { FeedbackNotes } from "./FeedbackNotes"
import baseline from "./migrations/0001_baseline"
import agentReviewHotspots from "./migrations/0002_agent_review_hotspots"
import agentReviewDone from "./migrations/0003_agent_review_done"
import outsideAgent from "./migrations/0004_outside_agent"
import conversationStartedWork from "./migrations/0005_conversation_started_work"
import turnSeen from "./migrations/0006_turn_seen"
import workReports from "./migrations/0007_work_reports"
import pastGlobalConversations from "./migrations/0008_past_global_conversations"
import globalConversationUpdates from "./migrations/0009_global_conversation_updates"
import toDoImages from "./migrations/0010_to_do_images"
import mermaidTourDiagrams from "./migrations/0011_mermaid_tour_diagrams"
import conversations from "./migrations/0012_conversations"
import journalHost from "./migrations/0013_journal_host"
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

    const startedWorkUpdate = StartedWorkUpdate.make({
      work: [
        ConversationOutcome.make({
          conversationId: "started",
          name: "Started",
          askedWith: "Build it",
          outcome: "finished",
          reason: null,
        }),
      ],
    })

    const context =
      '{"_tag":"Report","work":[{"_tag":"Agent","agentId":"started","name":"Started",' +
      '"askedWith":"Build it","outcome":"finished","reason":null}]}'

    const ended = encodeEnd({ at: DateTime.makeUnsafe(at), ending: TurnDone.make({}) })

    yield* sql`INSERT INTO global_conversation (id) VALUES ('global')`

    for (const [id, end] of [
      ["pending", null],
      ["completed", ended],
    ] as const)
      yield* sql`INSERT INTO agent_turn (id, agent_id, message, context, sent_at, ended)
        VALUES (${id}, 'global', '', ${context}, ${at}, ${end})`

    const sentNote =
      '[{"id":"sent","path":"greet.ts","side":"new","start":1,"end":1,"code":"A",' +
      '"changesId":"read-0","text":"Rename A"}]'

    yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, ended, feedback)
      VALUES ('ordinary', 'global', 'Report a bug', ${at}, ${ended}, ${sentNote})`
    yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at, reported_at)
      VALUES ('global', 'started', ${at}, ${at})`
    yield* sql`INSERT INTO conversation_agent_review (conversation_id, owner, repo, number, started_at, reported_at)
      VALUES ('global', 'glass-demo', 'greeter', 7, ${at}, ${at})`
    yield* sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, reported)
      VALUES ('glass-demo', 'greeter', 7, 'b', 'h', ${at}, 'Looks fine.', 1)`
    yield* sql`INSERT INTO agent_feedback_note
        (agent_id, id, path, side, start_line, end_line, code, changes_id, text, staged)
      VALUES ('started', 'note', 'greet.ts', 'new', 2, 2, 'B', 'read-1', 'Rename B', 1)`

    assert.deepStrictEqual(yield* SqliteMigrator.run({ loader: migrationLoader }), [
      [9, "global_conversation_updates"],
      [10, "to_do_images"],
      [11, "mermaid_tour_diagrams"],
      [12, "conversations"],
      [13, "journal_host"],
      [14, "conversation_branch"],
      [15, "feedback_notes"],
      [16, "turn_retries_delivery"],
      [17, "started_work"],
      [18, "page_notes"],
    ])
    const transcripts = yield* Transcripts
    const { turns } = yield* transcripts.read("global")
    assert.deepStrictEqual(
      turns.filter((turn) => turn.id !== "ordinary").map((turn) => turn.context),
      [startedWorkUpdate, startedWorkUpdate],
    )
    const ordinary = turns.find((turn) => turn.id === "ordinary")
    assert.equal(ordinary?.message, "Report a bug")
    assert.deepStrictEqual(ordinary?.feedback, [
      new LineNote({
        id: "sent",
        path: "greet.ts",
        side: "new",
        start: 1,
        end: 1,
        code: "A",
        changesId: "read-0",
        text: "Rename A",
      }),
    ])
    assert.deepStrictEqual(
      (yield* transcripts.retryDeliveries(["global"])).map((turn) => turn.turnId),
      ["pending"],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT started_work_update_outcome_at, started_work_update_turn_id FROM started_conversation`,
      [
        {
          started_work_update_outcome_at: at,
          started_work_update_turn_id: null,
        },
      ],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT started_work_update_outcome_at, started_work_update_turn_id FROM started_agent_review`,
      [
        {
          started_work_update_outcome_at: at,
          started_work_update_turn_id: null,
        },
      ],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT included_in_started_work_update, done FROM agent_reviews`,
      [{ included_in_started_work_update: 1, done: 0 }],
    )
    assert.deepStrictEqual(
      yield* (yield* FeedbackNotes).list("conversation:started"),
      new UnsentFeedback({
        notes: [
          new LineNote({
            id: "note",
            path: "greet.ts",
            side: "new",
            start: 2,
            end: 2,
            code: "B",
            changesId: "read-1",
            text: "Rename B",
          }),
        ],
        staged: ["note"],
      }),
    )
    yield* sql`UPDATE started_agent_review SET started_work_update_turn_id = 'completed'`
    yield* sql`DELETE FROM conversation_turn WHERE id = 'completed'`
    assert.deepStrictEqual(
      yield* sql`SELECT started_work_update_turn_id FROM started_agent_review`,
      [{ started_work_update_turn_id: null }],
    )
  }).pipe(
    Effect.provide([Transcripts.layer, FeedbackNotes.layer]),
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
        [10, "to_do_images"],
        [11, "mermaid_tour_diagrams"],
        [12, "conversations"],
        [13, "journal_host"],
        [14, "conversation_branch"],
        [15, "feedback_notes"],
        [16, "turn_retries_delivery"],
        [17, "started_work"],
        [18, "page_notes"],
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

      assert.deepStrictEqual(yield* sql`SELECT id, turn_seen_at FROM conversation ORDER BY id`, [
        { id: "fresh", turn_seen_at: null },
        { id: "worked", turn_seen_at: "2026-11-11T02:00:00.000Z" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live(
  "counts pre-existing work as already included when Started work updates are introduced",
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

        const [started] = yield* sql<{
          started_work_update_outcome_at: string
        }>`SELECT started_work_update_outcome_at FROM started_conversation`

        const [review] = yield* sql<{
          started_work_update_outcome_at: string
        }>`SELECT started_work_update_outcome_at FROM started_agent_review`

        assert.isTrue(started!.started_work_update_outcome_at > "2026-11-11T01:00:00.000Z")
        assert.isTrue(review!.started_work_update_outcome_at > "2026-11-11T01:00:00.000Z")
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

it.live("adds to-do images without touching to-dos written before them", () =>
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
          "0008_past_global_conversations": pastGlobalConversations,
        }),
      })

      yield* sql`INSERT INTO to_do (title, notes, created_at)
        VALUES ('Ship it', 'Before images', '2026-11-11T00:00:00.000Z')`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(yield* sql`SELECT id, title, notes FROM to_do`, [
        { id: 1, title: "Ship it", notes: "Before images" },
      ])
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'to_do_image'`,
        [{ name: "to_do_image" }],
      )
      assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS images FROM to_do_image`, [
        { images: 0 },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("drops node-and-edge Tour diagrams, keeping the rest of each saved Tour", () =>
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
          "0008_past_global_conversations": pastGlobalConversations,
          "0009_global_conversation_updates": globalConversationUpdates,
          "0010_to_do_images": toDoImages,
        }),
      })

      const diagram = { nodes: [{ id: "a" }], edges: [] }
      const callouts = [{ label: "Here", target: { path: "a.ts" } }]
      const plain = { title: "Two", explanation: "", files: [] }
      const chapter = { title: "One", explanation: "", files: [], callouts }
      const tour = { intent: "Greet by name.", beforeAfter: null, everythingElse: [] }
      const content = { ...tour, diagram, chapters: [{ ...chapter, diagram }, plain] }

      yield* sql`INSERT INTO tours (owner, repo, number, base, head, written_at, content)
        VALUES ('glass-demo', 'greeter', 7, 'b', 'h', '2026-11-14T12:00:00.000Z', ${JSON.stringify(content)})`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      const [row] = yield* sql<{ content: string }>`SELECT content FROM tours`
      assert.deepStrictEqual(JSON.parse(row!.content), { ...tour, chapters: [chapter, plain] })
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live(
  "renames Agents to Conversations, keeping their context, Steers, Activity, and Saved place",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = "2026-11-11T00:00:00.000Z"

        yield* SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({
            "0001_baseline": baseline,
            "0002_agent_review_hotspots": agentReviewHotspots,
            "0003_agent_review_done": agentReviewDone,
            "0004_outside_agent": outsideAgent,
            "0005_conversation_started_work": conversationStartedWork,
            "0006_turn_seen": turnSeen,
            "0007_work_reports": workReports,
            "0008_past_global_conversations": pastGlobalConversations,
            "0009_global_conversation_updates": globalConversationUpdates,
            "0010_to_do_images": toDoImages,
            "0011_mermaid_tour_diagrams": mermaidTourDiagrams,
          }),
        })

        const viewing = '{"_tag":"Agent","agentId":"otter","name":"agent/swift-otter"}'

        yield* sql`INSERT INTO agent (id, name, owner, repo, base_branch, engine, folder, created_at)
        VALUES ('otter', 'agent/swift-otter', 'glass-demo', 'greeter', 'main', 'pi', 'otter', ${at})`
        yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, context)
        VALUES ('asked', 'global', 'How is it going?', ${at}, ${viewing})`
        yield* sql`INSERT INTO agent_turn_part (turn_id, position, part)
        VALUES ('asked', 0, ${'{"_tag":"Steer","message":"Also this","images":[],"context":' + viewing + "}"})`
        yield* sql`INSERT INTO agent_queued_message (id, agent_id, position, message, images, context)
        VALUES ('next', 'global', 0, 'And now?', '[]', ${viewing})`
        yield* sql`INSERT INTO conversation_agent (conversation_id, agent_id, started_at)
        VALUES ('global', 'otter', ${at})`
        yield* sql`INSERT INTO activity (kind, payload, occurred_at, login)
        VALUES ('AgentStarted', '{"_tag":"AgentStarted","agentId":"otter","engine":"pi"}', ${at}, 'kevin')`
        yield* sql`INSERT INTO saved_place (area, destination, saved_at)
        VALUES ('agents', '{"area":"agents","agentId":"otter"}', ${at})`

        yield* SqliteMigrator.run({ loader: migrationLoader })

        const renamed = ConversationContext.make({
          conversationId: "otter",
          name: "agent/swift-otter",
        })

        const { turns, queued } = yield* (yield* Transcripts).read("global")

        assert.deepStrictEqual(yield* sql`SELECT id, harness FROM conversation`, [
          { id: "otter", harness: "pi" },
        ])
        assert.deepStrictEqual(
          turns.map(({ context, parts }) => ({ context, parts })),
          [
            {
              context: renamed,
              parts: [SteerPart.make({ message: "Also this", images: [], context: renamed })],
            },
          ],
        )
        assert.deepStrictEqual(
          queued.map(({ context }) => context),
          [renamed],
        )
        assert.deepStrictEqual(
          yield* sql`SELECT started_by, conversation_id FROM started_conversation`,
          [{ started_by: "global", conversation_id: "otter" }],
        )
        assert.deepStrictEqual(yield* sql`SELECT kind, payload FROM activity`, [
          {
            kind: "ConversationStarted",
            payload: '{"_tag":"ConversationStarted","conversationId":"otter","harness":"pi"}',
          },
        ])
        assert.deepStrictEqual(yield* sql`SELECT area, destination FROM saved_place`, [
          {
            area: "conversations",
            destination: '{"area":"conversations","conversationId":"otter"}',
          },
        ])
      }).pipe(
        Effect.provide(Transcripts.layer),
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
    }),
)

it.live(
  "records each work Conversation's branch as its name, leaving review checkouts detached",
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
            "0007_work_reports": workReports,
            "0008_past_global_conversations": pastGlobalConversations,
            "0009_global_conversation_updates": globalConversationUpdates,
            "0010_to_do_images": toDoImages,
            "0011_mermaid_tour_diagrams": mermaidTourDiagrams,
            "0012_conversations": conversations,
            "0013_journal_host": journalHost,
          }),
        })

        for (const [id, brief] of [
          ["work", null],
          ["review", "{}"],
        ] as const)
          yield* sql`INSERT INTO conversation (id, name, owner, repo, base_branch, harness, folder, created_at, review_brief)
          VALUES (${id}, ${`agent/${id}`}, 'glass-demo', 'greeter', 'main', 'pi', ${id}, '2026-11-17T00:00:00.000Z', ${brief})`

        yield* SqliteMigrator.run({ loader: migrationLoader })

        assert.deepStrictEqual(yield* sql`SELECT id, branch FROM conversation ORDER BY id`, [
          { id: "review", branch: null },
          { id: "work", branch: "agent/work" },
        ])
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
    }),
)

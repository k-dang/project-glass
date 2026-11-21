import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  ThreadContext,
  ThreadOutcome,
  StartedWorkUpdate,
  SteerPart,
  TurnDone,
  TurnEnd,
} from "@glass/contracts"
import { DateTime, Effect, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { join } from "node:path"
import { isolatedHome } from "../test/harness"
import { migrationLoader, migrations } from "./Migrations"
import { Transcripts } from "./Transcripts"

const migrationsThrough = (last: keyof typeof migrations) =>
  SqliteMigrator.fromRecord(
    Object.fromEntries(Object.entries(migrations).filter(([id]) => id <= last)),
  )

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

it.live("upgrades main's schema directly, preserving completed and unfinished updates", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* SqliteMigrator.run({ loader: migrationsThrough("0008_past_global_conversations") })

    const at = "2026-11-14T12:00:00.000Z"

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
    yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at, ended)
      VALUES ('ordinary', 'global', 'Report a bug', ${at}, ${ended})`
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
      [18, "conversation_kept_going"],
      [19, "global_chat_sessions"],
      [20, "review_thread_replies"],
      [21, "threads"],
    ])
    const transcripts = yield* Transcripts
    const { turns } = yield* transcripts.read("global")
    assert.deepStrictEqual(
      turns.filter((turn) => turn.id !== "ordinary").map((turn) => turn.context),
      [startedWorkUpdate, startedWorkUpdate],
    )
    assert.equal(turns.find((turn) => turn.id === "ordinary")?.message, "Report a bug")
    assert.deepStrictEqual(
      (yield* transcripts.retryDeliveries(["global"])).map((turn) => turn.turnId),
      ["pending"],
    )
    assert.deepStrictEqual(
      yield* sql`SELECT started_work_update_outcome_at, started_work_update_turn_id FROM started_thread`,
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
    assert.deepStrictEqual(yield* sql`SELECT owner, id, text, staged FROM feedback_note`, [
      { owner: "thread:started", id: "note", text: "Rename B", staged: 1 },
    ])
    yield* sql`UPDATE started_agent_review SET started_work_update_turn_id = 'completed'`
    yield* sql`DELETE FROM thread_turn WHERE id = 'completed'`
    assert.deepStrictEqual(
      yield* sql`SELECT started_work_update_turn_id FROM started_agent_review`,
      [{ started_work_update_turn_id: null }],
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
        [10, "to_do_images"],
        [11, "mermaid_tour_diagrams"],
        [12, "conversations"],
        [13, "journal_host"],
        [14, "conversation_branch"],
        [15, "feedback_notes"],
        [16, "turn_retries_delivery"],
        [17, "started_work"],
        [18, "conversation_kept_going"],
        [19, "global_chat_sessions"],
        [20, "review_thread_replies"],
        [21, "threads"],
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
        loader: migrationsThrough("0001_baseline"),
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
        loader: migrationsThrough("0005_conversation_started_work"),
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

      assert.deepStrictEqual(yield* sql`SELECT id, turn_seen_at FROM thread ORDER BY id`, [
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
          loader: migrationsThrough("0006_turn_seen"),
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
        }>`SELECT started_work_update_outcome_at FROM started_thread`

        const [review] = yield* sql<{
          started_work_update_outcome_at: string
        }>`SELECT started_work_update_outcome_at FROM started_agent_review`

        assert.isTrue(started!.started_work_update_outcome_at > "2026-11-11T01:00:00.000Z")
        assert.isTrue(review!.started_work_update_outcome_at > "2026-11-11T01:00:00.000Z")
        assert.deepStrictEqual(yield* sql`SELECT turn_seen_at FROM global_chat_session`, [
          { turn_seen_at: "2026-11-11T01:00:00.000Z" },
        ])
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
    }),
)

it.live("keeps the Global chat's pi session, started at its first Turn", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: migrationsThrough("0007_work_reports"),
      })

      yield* sql`INSERT INTO global_conversation (id) VALUES ('global')`

      for (const [id, at] of [
        ["second", "2026-11-11T02:00:00.000Z"],
        ["first", "2026-11-11T01:00:00.000Z"],
      ] as const)
        yield* sql`INSERT INTO agent_turn (id, agent_id, message, sent_at)
          VALUES (${id}, 'global', 'Say hello', ${at})`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(yield* sql`SELECT id, started_at FROM global_chat_session`, [
        { id: "global", started_at: "2026-11-11T01:00:00.000Z" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("adds to-do images without touching to-dos written before them", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: migrationsThrough("0008_past_global_conversations"),
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
        loader: migrationsThrough("0010_to_do_images"),
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

it.live("renames Agents to Threads, keeping their context, Steers, Activity, and Saved place", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const at = "2026-11-11T00:00:00.000Z"

      yield* SqliteMigrator.run({
        loader: migrationsThrough("0011_mermaid_tour_diagrams"),
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

      const renamed = ThreadContext.make({
        threadId: "otter",
        name: "agent/swift-otter",
      })

      const { turns, queued } = yield* (yield* Transcripts).read("global")

      assert.deepStrictEqual(yield* sql`SELECT id, harness FROM thread`, [
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
      assert.deepStrictEqual(yield* sql`SELECT started_by, thread_id FROM started_thread`, [
        { started_by: "global", thread_id: "otter" },
      ])
      assert.deepStrictEqual(yield* sql`SELECT kind, payload FROM activity`, [
        {
          kind: "ThreadStarted",
          payload: '{"_tag":"ThreadStarted","harness":"pi","threadId":"otter"}',
        },
      ])
      assert.deepStrictEqual(yield* sql`SELECT area, destination FROM saved_place`, [
        {
          area: "threads",
          destination: '{"area":"threads","threadId":"otter"}',
        },
      ])
    }).pipe(
      Effect.provide(Transcripts.layer),
      Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
      Effect.scoped,
    )
  }),
)

it.live("records each work Thread's branch as its name, leaving review checkouts detached", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: migrationsThrough("0013_journal_host"),
      })

      for (const [id, brief] of [
        ["work", null],
        ["review", "{}"],
      ] as const)
        yield* sql`INSERT INTO conversation (id, name, owner, repo, base_branch, harness, folder, created_at, review_brief)
          VALUES (${id}, ${`agent/${id}`}, 'glass-demo', 'greeter', 'main', 'pi', ${id}, '2026-11-17T00:00:00.000Z', ${brief})`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(yield* sql`SELECT id, branch FROM thread ORDER BY id`, [
        { id: "review", branch: null },
        { id: "work", branch: "agent/work" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live(
  "dates when each Thread was last kept going from the user's Turns, ignoring Glass's own",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient

        yield* SqliteMigrator.run({
          loader: migrationsThrough("0017_started_work"),
        })

        for (const id of ["written", "quiet"])
          yield* sql`INSERT INTO conversation (id, name, owner, repo, base_branch, harness, folder, created_at)
          VALUES (${id}, ${`agent/${id}`}, 'glass-demo', 'greeter', 'main', 'pi', ${id}, '2026-11-17T00:00:00.000Z')`

        for (const [id, context, sentAt] of [
          ["first", null, "2026-11-18T00:00:00.000Z"],
          [
            "viewing",
            '{"_tag":"Conversation","conversationId":"quiet","name":"agent/quiet"}',
            "2026-11-19T00:00:00.000Z",
          ],
          ["update", '{"_tag":"StartedWorkUpdate","work":[]}', "2026-11-20T00:00:00.000Z"],
        ] as const)
          yield* sql`INSERT INTO conversation_turn (id, conversation_id, message, context, sent_at)
          VALUES (${id}, 'written', '', ${context}, ${sentAt})`

        yield* SqliteMigrator.run({ loader: migrationLoader })

        assert.deepStrictEqual(
          yield* sql`SELECT id, kept_going_at AS keptGoingAt FROM thread ORDER BY id`,
          [
            { id: "quiet", keptGoingAt: "2026-11-17T00:00:00.000Z" },
            { id: "written", keptGoingAt: "2026-11-19T00:00:00.000Z" },
          ],
        )
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
    }),
)

it.live(
  "keeps the Global chat's settings and moves its current and ended Sessions into one table",
  () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome

      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = "2026-11-19T00:00:00.000Z"

        yield* SqliteMigrator.run({
          loader: migrationsThrough("0018_conversation_kept_going"),
        })

        const ended = "2026-11-19T01:00:00.000Z"
        const seen = "2026-11-19T02:00:00.000Z"

        yield* sql`INSERT INTO global_conversation (id, session_id, session_started_at, turn_seen_at, model)
        VALUES ('global', 'current', ${ended}, ${seen}, 'gpt-test')`
        yield* sql`INSERT INTO past_global_conversation (id, started_at, ended_at)
        VALUES ('earlier', ${at}, ${ended})`

        assert.deepStrictEqual(yield* SqliteMigrator.run({ loader: migrationLoader }), [
          [19, "global_chat_sessions"],
          [20, "review_thread_replies"],
          [21, "threads"],
        ])
        assert.deepStrictEqual(yield* sql`SELECT * FROM global_chat`, [
          { id: "global", model: "gpt-test", effort: null, singleton: 1 },
        ])
        assert.deepStrictEqual(
          yield* sql`SELECT id, started_at, ended_at, turn_seen_at FROM global_chat_session ORDER BY started_at`,
          [
            { id: "earlier", started_at: at, ended_at: ended, turn_seen_at: null },
            { id: "current", started_at: ended, ended_at: null, turn_seen_at: seen },
          ],
        )
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_schema WHERE name = 'past_global_conversation'`,
          [],
        )
      }).pipe(
        Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })),
        Effect.scoped,
      )
    }),
)

it.live("moves each sent Reply's Activity onto its Review thread's id", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      yield* SqliteMigrator.run({
        loader: migrationsThrough("0019_global_chat_sessions"),
      })

      const at = "2026-11-20T00:00:00.000Z"

      yield* sql`INSERT INTO activity (kind, payload, occurred_at, login) VALUES
        ('ReplySent', '{"_tag":"ReplySent","discussionId":"PRRT_1","body":"Done."}', ${at}, 'kevin'),
        ('ToDoDone', '{"_tag":"ToDoDone","toDo":{"id":1,"title":"Ship it"}}', ${at}, 'kevin')`

      yield* SqliteMigrator.run({ loader: migrationLoader })

      assert.deepStrictEqual(yield* sql`SELECT payload FROM activity ORDER BY id`, [
        { payload: '{"_tag":"ReplySent","body":"Done.","reviewThreadId":"PRRT_1"}' },
        { payload: '{"_tag":"ToDoDone","toDo":{"id":1,"title":"Ship it"}}' },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: join(home, "glass.db") })), Effect.scoped)
  }),
)

it.live("leaves no table, column, or index named for Conversations", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* SqliteMigrator.run({ loader: migrationLoader })

    assert.deepStrictEqual(
      yield* sql`SELECT name FROM sqlite_schema WHERE name LIKE '%conversation%' OR sql LIKE '%conversation%'`,
      [],
    )
  }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:" }))),
)

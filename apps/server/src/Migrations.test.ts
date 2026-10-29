import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { assert, it } from "@effect/vitest"
import {
  Activity,
  applyTranscriptUpdate,
  emptyTranscript,
  ActivityPullRequest,
  FileViewed,
  PullRequestOpened,
  PullRequestRef,
  Revision,
  TextPart,
} from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { isolatedHome, startBackend } from "../test/harness"
import { migrationLoader, migrations } from "./Migrations"
import createActivity from "./migrations/0001_create_activity"

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(Activity))

it.live("upgrades existing Activity history and uses its indexes after reopening", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const filename = join(home, "glass.db")
    const ref = new PullRequestRef({ owner: "acme", repo: "api", number: 42 })
    const revision = new Revision({ base: "b0", head: "h1" })
    const pullRequest = new ActivityPullRequest({ ref, title: "Greet them", revision })

    const before = (kind: string) =>
      `{"pullRequest":${JSON.stringify(ref)},"title":"Greet them","revision":${JSON.stringify(revision)},"kind":${kind}}`

    const opened = '{"_tag":"PullRequestOpened"}'
    const viewed = '{"_tag":"FileViewed","path":"greet.ts"}'
    const occurredAt = "2026-10-20T00:00:00Z"

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({
        loader: SqliteMigrator.fromRecord({ "0001_create_activity": createActivity }),
      })
      yield* sql`
        INSERT INTO activity (kind, payload, occurred_at, login)
        VALUES ('PullRequestOpened', ${before(opened)}, ${occurredAt}, 'Kevin'),
               ('FileViewed', ${before(viewed)}, ${occurredAt}, 'Kevin'),
               ('PullRequestOpened', ${before(opened)}, ${occurredAt}, 'another-user')
      `
    }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

    const upgrade = [
      [2, "index_touched_prs"],
      [3, "index_activity_by_login"],
      [4, "create_to_do"],
      [5, "nest_pull_request_in_activity"],
      [6, "create_queued_pull_request"],
      [7, "create_tours"],
      [8, "add_revision_to_queued_pull_request"],
      [9, "create_saved_place"],
      [10, "create_agent_reviews"],
      [11, "create_agents"],
      [12, "agent_models"],
      [13, "images_queued_and_unsent_messages"],
      [14, "agent_permission_mode"],
      [15, "agent_reviews_as_markdown"],
      [16, "agent_sandboxes"],
      [17, "agent_place"],
    ] as const

    for (const expected of [upgrade, []] as const) {
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        assert.deepStrictEqual(yield* SqliteMigrator.run({ loader: migrationLoader }), expected)

        const rows = yield* sql<{
          kind: string
          payload: string
          occurred_at: string
          login: string
        }>`
          SELECT kind, payload, occurred_at, login FROM activity ORDER BY id
        `

        assert.deepStrictEqual(
          rows.map((row) => ({ ...row, payload: decodeStored(row.payload) })),
          [
            {
              kind: "PullRequestOpened",
              payload: PullRequestOpened.make({ pullRequest }),
              occurred_at: occurredAt,
              login: "Kevin",
            },
            {
              kind: "FileViewed",
              payload: FileViewed.make({ pullRequest, path: "greet.ts" }),
              occurred_at: occurredAt,
              login: "Kevin",
            },
            {
              kind: "PullRequestOpened",
              payload: PullRequestOpened.make({ pullRequest }),
              occurred_at: occurredAt,
              login: "another-user",
            },
          ],
        )
        assert.deepStrictEqual(
          yield* sql`
            SELECT DISTINCT json_extract(payload, '$.pullRequest.ref') AS ref
            FROM activity
            WHERE lower(login) = lower(${"kevin"})
              AND json_extract(payload, '$.pullRequest.ref') IS NOT NULL
          `,
          [{ ref: JSON.stringify(ref) }],
        )

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
      }).pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)
    }
  }),
)

it.live("keeps an Agent's Turns, with no images, when Queued and unsent messages arrive", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    yield* Effect.promise(() => mkdir(join(home, ".project-glass"), { recursive: true }))

    const before = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0013"))

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(before) })
      yield* sql`
        INSERT INTO agent (id, name, machine, owner, repo, base_branch, engine, worktree, created_at)
        VALUES ('agent-1', 'agent/swift-otter', 'this-mac', 'acme', 'api', 'main', 'pi-cli',
          ${join(home, "worktree")}, '2026-10-20T00:00:00Z')
      `
      yield* sql`
        INSERT INTO agent_turn (id, agent_id, message, sent_at, ended)
        VALUES ('turn-1', 'agent-1', 'Say hello', '2026-10-20T00:00:00Z',
          '{"at":"2026-10-20T00:00:03Z","ending":{"_tag":"Done"}}')
      `
      yield* sql`
        INSERT INTO agent_turn_part (turn_id, position, part)
        VALUES ('turn-1', 0, '{"_tag":"Text","text":"Hello!"}')
      `
    }).pipe(
      Effect.provide(SqliteClient.layer({ filename: join(home, ".project-glass", "glass.db") })),
      Effect.scoped,
    )

    const { client } = yield* startBackend({}, home)

    const transcript = yield* client.WatchTranscript({ agentId: "agent-1" }).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.drop(1),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    assert.deepStrictEqual(transcript.queued, [])
    assert.deepStrictEqual(
      transcript.turns.map(({ message, images, parts }) => ({ message, images, parts })),
      [{ message: "Say hello", images: [], parts: [TextPart.make({ text: "Hello!" })] }],
    )
  }),
)

it.live("rewrites saved Agent reviews as Markdown and drops those that no longer decode", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const filename = join(home, "glass.db")
    const before = Object.fromEntries(Object.entries(migrations).filter(([id]) => id < "0015"))

    const saved = {
      headline: "The greeting drops punctuation.",
      summary: "It takes a name now.",
      findings: [
        {
          rating: "blocking",
          title: "Punctuation is dropped",
          body: "`greet` strips the `!`.",
          place: { kind: "line", path: "greet.ts", side: "new", line: 2 },
        },
        {
          rating: "nit",
          title: "Old wording",
          body: "It read better.",
          place: { kind: "file", path: "greet.ts", lineOutsideDiff: { side: "old", line: 1 } },
        },
        {
          rating: "should-fix",
          title: "No tests",
          body: "Add one.",
          place: { kind: "pull-request" },
        },
      ],
    }

    const run = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
      effect.pipe(Effect.provide(SqliteClient.layer({ filename })), Effect.scoped)

    yield* run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* SqliteMigrator.run({ loader: SqliteMigrator.fromRecord(before) })
        yield* sql`
          INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, content, folded)
          VALUES ('acme', 'api', 1, 'b0', 'h1', '2026-10-20T00:00:00Z', ${JSON.stringify(saved)}, '[1]'),
                 ('acme', 'api', 2, 'b0', 'h1', '2026-10-20T00:00:00Z', 'not JSON', '[]')
        `
      }),
    )

    const rows = yield* run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* SqliteMigrator.run({ loader: migrationLoader })

        return yield* sql`SELECT * FROM agent_reviews`
      }),
    )

    assert.deepStrictEqual(rows, [
      {
        owner: "acme",
        repo: "api",
        number: 1,
        base: "b0",
        head: "h1",
        written_at: "2026-10-20T00:00:00Z",
        markdown: [
          "**The greeting drops punctuation.** It takes a name now.",
          "## Punctuation is dropped\n\nBlocking · `greet.ts:2`\n\n`greet` strips the `!`.",
          "## Old wording\n\nNit · `greet.ts:1` (old)\n\nIt read better.",
          "## No tests\n\nShould fix\n\nAdd one.",
        ].join("\n\n"),
      },
    ])
  }),
)

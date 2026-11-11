import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE activity (
      id INTEGER PRIMARY KEY,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      login TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX activity_login_id ON activity(lower(login), id)`
  yield* sql`
    CREATE INDEX activity_login_pr
    ON activity(lower(login), json_extract(payload, '$.pullRequest.ref'))
  `
  yield* sql`CREATE INDEX activity_login_kind_time ON activity(lower(login), kind, occurred_at)`

  yield* sql`
    CREATE TABLE agent (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      base_branch TEXT NOT NULL,
      engine TEXT NOT NULL,
      folder TEXT NOT NULL,
      created_at TEXT NOT NULL,
      model TEXT,
      effort TEXT,
      permission_mode TEXT,
      sandbox_provider TEXT,
      sandbox TEXT,
      journal_saved INTEGER NOT NULL DEFAULT 0,
      review_brief TEXT,
      local_skills INTEGER NOT NULL DEFAULT 0
    )
  `

  yield* sql`
    CREATE TABLE agent_feedback_note (
      agent_id TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      code TEXT NOT NULL,
      changes_id TEXT NOT NULL,
      text TEXT NOT NULL,
      staged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (agent_id, id)
    )
  `

  yield* sql`
    CREATE TABLE agent_queued_message (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      message TEXT NOT NULL,
      images TEXT NOT NULL,
      context TEXT,
      feedback TEXT NOT NULL DEFAULT '[]'
    )
  `
  yield* sql`
    CREATE INDEX agent_queued_message_by_agent ON agent_queued_message (agent_id, position)
  `

  yield* sql`
    CREATE TABLE agent_reviews (
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      base TEXT NOT NULL,
      head TEXT NOT NULL,
      written_at TEXT NOT NULL,
      markdown TEXT NOT NULL,
      agent_id TEXT,
      PRIMARY KEY (owner, repo, number)
    )
  `

  yield* sql`
    CREATE TABLE agent_skill_pack (
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      pin_id INTEGER NOT NULL,
      PRIMARY KEY (agent_id, name)
    )
  `

  yield* sql`
    CREATE TABLE agent_turn (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      ended TEXT,
      images TEXT NOT NULL DEFAULT '[]',
      context TEXT,
      feedback TEXT NOT NULL DEFAULT '[]'
    )
  `
  yield* sql`CREATE INDEX agent_turn_by_agent ON agent_turn (agent_id)`

  yield* sql`
    CREATE TABLE agent_turn_part (
      turn_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      part TEXT NOT NULL,
      PRIMARY KEY (turn_id, position)
    )
  `

  yield* sql`
    CREATE TABLE agent_unsent_message (
      agent_id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      images TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE global_conversation (
      id TEXT PRIMARY KEY,
      model TEXT,
      effort TEXT,
      singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK (singleton = 1)
    )
  `

  yield* sql`
    CREATE TABLE local_checkout (
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      path TEXT NOT NULL,
      remote TEXT NOT NULL,
      PRIMARY KEY (owner, repo)
    )
  `

  yield* sql`
    CREATE TABLE queued_pull_request (
      reference_key TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      state TEXT NOT NULL,
      opened_at TEXT,
      missing INTEGER NOT NULL DEFAULT 0,
      base TEXT,
      head TEXT
    )
  `

  yield* sql`
    CREATE TABLE saved_place (
      area TEXT PRIMARY KEY,
      destination TEXT NOT NULL,
      saved_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE skill_pack (
      name TEXT PRIMARY KEY,
      ref TEXT,
      pin_id INTEGER NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE skill_pack_file (
      pin_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      executable INTEGER NOT NULL,
      contents BLOB NOT NULL,
      PRIMARY KEY (pin_id, path)
    )
  `

  yield* sql`
    CREATE TABLE skill_pack_pin (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      UNIQUE (owner, repo, path, commit_sha)
    )
  `

  yield* sql`
    CREATE TABLE skill_pack_skill (
      pin_id INTEGER NOT NULL,
      directory TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      PRIMARY KEY (pin_id, directory)
    )
  `

  yield* sql`
    CREATE TABLE to_do (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `

  yield* sql`
    CREATE TABLE tours (
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      base TEXT NOT NULL,
      head TEXT NOT NULL,
      written_at TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    )
  `
})

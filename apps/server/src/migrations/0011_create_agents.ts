import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

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
    CREATE TABLE agent (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      machine TEXT NOT NULL,
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      base_branch TEXT NOT NULL,
      engine TEXT NOT NULL,
      worktree TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `

  yield* sql`
    CREATE TABLE agent_turn (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      message TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      ended TEXT
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
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE conversation_agent (
      conversation_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      asked_with TEXT,
      started_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, agent_id)
    )
  `

  yield* sql`
    CREATE TABLE conversation_agent_review (
      conversation_id TEXT NOT NULL,
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      asked_with TEXT,
      started_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, owner, repo, number)
    )
  `
})

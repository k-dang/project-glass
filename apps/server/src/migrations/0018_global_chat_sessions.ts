import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE global_conversation RENAME TO global_chat`

  yield* sql`
    CREATE TABLE global_chat_session (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      turn_seen_at TEXT
    )
  `
  yield* sql`
    CREATE UNIQUE INDEX global_chat_session_current
    ON global_chat_session ((ended_at IS NULL)) WHERE ended_at IS NULL
  `

  yield* sql`
    INSERT INTO global_chat_session (id, started_at, ended_at)
    SELECT id, started_at, ended_at FROM past_global_conversation
  `
  yield* sql`
    INSERT INTO global_chat_session (id, started_at, turn_seen_at)
    SELECT session_id, session_started_at, turn_seen_at FROM global_chat WHERE session_id IS NOT NULL
  `

  yield* sql`DROP TABLE past_global_conversation`

  for (const column of ["session_id", "session_started_at", "turn_seen_at"])
    yield* sql`ALTER TABLE global_chat DROP COLUMN ${sql(column)}`
})

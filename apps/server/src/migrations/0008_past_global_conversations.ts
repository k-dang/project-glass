import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE global_conversation ADD COLUMN session_id TEXT`
  yield* sql`ALTER TABLE global_conversation ADD COLUMN session_started_at TEXT`

  yield* sql`
    UPDATE global_conversation SET session_id = id, session_started_at = COALESCE(
      (SELECT MIN(t.sent_at) FROM agent_turn t WHERE t.agent_id = global_conversation.id),
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    )
  `

  yield* sql`
    CREATE TABLE past_global_conversation (
      id TEXT PRIMARY KEY,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL
    )
  `
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_agent ADD COLUMN reported_at TEXT`
  yield* sql`UPDATE conversation_agent SET reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

  yield* sql`ALTER TABLE conversation_agent_review ADD COLUMN reported_at TEXT`
  yield* sql`
    UPDATE conversation_agent_review SET reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `

  yield* sql`ALTER TABLE agent_reviews ADD COLUMN reported INTEGER NOT NULL DEFAULT 0`

  yield* sql`ALTER TABLE global_conversation ADD COLUMN turn_seen_at TEXT`

  yield* sql`
    UPDATE global_conversation SET turn_seen_at = (
      SELECT MAX(json_extract(t.ended, '$.at')) FROM agent_turn t
      WHERE t.agent_id = global_conversation.id
    )
  `
})

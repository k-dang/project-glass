import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_agent ADD COLUMN global_conversation_update_turn_id TEXT REFERENCES agent_turn(id) ON DELETE SET NULL`
  yield* sql`ALTER TABLE conversation_agent_review ADD COLUMN global_conversation_update_turn_id TEXT REFERENCES agent_turn(id) ON DELETE SET NULL`
  yield* sql`ALTER TABLE conversation_agent RENAME COLUMN reported_at TO global_conversation_update_outcome_at`
  yield* sql`ALTER TABLE conversation_agent_review RENAME COLUMN reported_at TO global_conversation_update_outcome_at`
  yield* sql`ALTER TABLE agent_reviews RENAME COLUMN reported TO included_in_global_conversation_update`

  yield* sql`
    UPDATE agent_turn SET context = json_set(context, '$._tag', 'GlobalConversationUpdate')
    WHERE json_extract(context, '$._tag') = 'Report'
  `
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_agent RENAME COLUMN work_update_outcome_at TO global_conversation_update_outcome_at`
  yield* sql`ALTER TABLE conversation_agent RENAME COLUMN work_update_turn_id TO global_conversation_update_turn_id`
  yield* sql`ALTER TABLE conversation_agent_review RENAME COLUMN work_update_outcome_at TO global_conversation_update_outcome_at`
  yield* sql`ALTER TABLE conversation_agent_review RENAME COLUMN work_update_turn_id TO global_conversation_update_turn_id`
  yield* sql`ALTER TABLE agent_reviews RENAME COLUMN included_in_work_update TO included_in_global_conversation_update`

  yield* sql`
    UPDATE agent_turn SET context = json_set(context, '$._tag', 'GlobalConversationUpdate')
    WHERE json_extract(context, '$._tag') = 'WorkUpdate'
  `
})

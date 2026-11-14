import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_agent RENAME COLUMN reported_at TO work_update_outcome_at`
  yield* sql`ALTER TABLE conversation_agent RENAME COLUMN report_turn_id TO work_update_turn_id`
  yield* sql`ALTER TABLE conversation_agent_review RENAME COLUMN reported_at TO work_update_outcome_at`
  yield* sql`ALTER TABLE conversation_agent_review RENAME COLUMN report_turn_id TO work_update_turn_id`
  yield* sql`ALTER TABLE agent_reviews RENAME COLUMN reported TO included_in_work_update`

  yield* sql`
    UPDATE agent_turn SET context = json_set(context, '$._tag', 'WorkUpdate')
    WHERE json_extract(context, '$._tag') = 'Report'
  `
})

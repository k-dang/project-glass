import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  for (const [from, to] of [
    ["global_started_conversation", "started_conversation"],
    ["global_started_agent_review", "started_agent_review"],
  ] as const) {
    yield* sql`ALTER TABLE ${sql(from)} RENAME TO ${sql(to)}`
    yield* sql`ALTER TABLE ${sql(to)} RENAME COLUMN global_conversation_id TO started_by`
    yield* sql`ALTER TABLE ${sql(to)} RENAME COLUMN global_conversation_update_outcome_at TO started_work_update_outcome_at`
    yield* sql`ALTER TABLE ${sql(to)} RENAME COLUMN global_conversation_update_turn_id TO started_work_update_turn_id`
  }

  yield* sql`ALTER TABLE agent_reviews RENAME COLUMN included_in_global_conversation_update TO included_in_started_work_update`

  yield* sql`
    UPDATE conversation_turn SET context = json_set(context, '$._tag', 'StartedWorkUpdate')
    WHERE json_extract(context, '$._tag') = 'GlobalConversationUpdate'
  `
})

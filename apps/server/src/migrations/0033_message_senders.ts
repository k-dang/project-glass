import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE thread ADD COLUMN created_by TEXT`
  yield* sql`ALTER TABLE thread_queued_message ADD COLUMN sent_by TEXT NOT NULL DEFAULT 'agent'`
  yield* sql`ALTER TABLE thread_turn ADD COLUMN started_by TEXT NOT NULL DEFAULT 'user'`
  yield* sql`
    UPDATE thread_turn SET started_by = 'glass'
    WHERE json_extract(context, '$._tag') IN ('StartedWorkUpdate', 'Update', 'AgentReview')
  `
  yield* sql`
    UPDATE thread_turn SET started_by = 'harness'
    WHERE json_extract(context, '$._tag') = 'BackgroundWorkEnded'
  `
  yield* sql`CREATE INDEX thread_turn_running ON thread_turn (thread_id) WHERE ended IS NULL`
})

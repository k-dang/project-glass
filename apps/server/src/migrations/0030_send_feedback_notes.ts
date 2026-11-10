import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_feedback_note ADD COLUMN staged INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE agent_turn ADD COLUMN feedback TEXT NOT NULL DEFAULT '[]'`
  yield* sql`ALTER TABLE agent_queued_message ADD COLUMN feedback TEXT NOT NULL DEFAULT '[]'`
})

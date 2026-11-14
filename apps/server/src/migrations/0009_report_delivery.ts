import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_agent ADD COLUMN report_turn_id TEXT REFERENCES agent_turn(id) ON DELETE SET NULL`
  yield* sql`ALTER TABLE conversation_agent_review ADD COLUMN report_turn_id TEXT REFERENCES agent_turn(id) ON DELETE SET NULL`
})

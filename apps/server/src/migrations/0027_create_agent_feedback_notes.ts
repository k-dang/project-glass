import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE agent_feedback_note (
      agent_id TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      code TEXT NOT NULL,
      changes_id TEXT NOT NULL,
      text TEXT NOT NULL,
      PRIMARY KEY (agent_id, id)
    )
  `
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE conversation_to_do (
      conversation_id TEXT NOT NULL,
      to_do_id INTEGER NOT NULL,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (conversation_id, to_do_id)
    )
  `
})

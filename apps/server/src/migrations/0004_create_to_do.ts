import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE to_do (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      notes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    )
  `
})

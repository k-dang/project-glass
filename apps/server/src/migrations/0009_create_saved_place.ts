import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE saved_place (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      destination TEXT NOT NULL,
      saved_at TEXT NOT NULL
    )
  `
})

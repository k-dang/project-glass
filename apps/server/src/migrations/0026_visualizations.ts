import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE visualization (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      html TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX visualization_thread ON visualization (thread_id)`
})

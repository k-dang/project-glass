import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE subscription (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      source TEXT NOT NULL,
      subject TEXT NOT NULL,
      reasons TEXT NOT NULL,
      note TEXT NOT NULL,
      last_told TEXT,
      created_at TEXT NOT NULL,
      ended TEXT
    )
  `
  yield* sql`CREATE INDEX subscription_thread ON subscription (thread_id)`
})

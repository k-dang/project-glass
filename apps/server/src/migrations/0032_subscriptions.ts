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
      subject_key TEXT NOT NULL,
      kinds TEXT NOT NULL,
      note TEXT NOT NULL,
      delivered_through INTEGER NOT NULL,
      updates_in_a_row INTEGER NOT NULL DEFAULT 0,
      after_message TEXT,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX subscription_thread ON subscription (thread_id)`
  yield* sql`
    CREATE UNIQUE INDEX subscription_subject ON subscription (thread_id, source, subject_key)
  `
})

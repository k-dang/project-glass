import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE queued_pull_request (
      reference_key TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      queued_at TEXT NOT NULL,
      summary TEXT NOT NULL,
      state TEXT NOT NULL,
      opened_at TEXT,
      missing INTEGER NOT NULL DEFAULT 0
    )
  `
})

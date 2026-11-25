import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE check_in (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      asked_by TEXT NOT NULL,
      folder TEXT NOT NULL,
      summary TEXT,
      changes TEXT NOT NULL,
      changes_id TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      outcome TEXT,
      told INTEGER NOT NULL DEFAULT 0
    )
  `
  yield* sql`CREATE INDEX check_in_waiting ON check_in (folder) WHERE outcome IS NULL`
  yield* sql`CREATE INDEX check_in_untold ON check_in (agent_id) WHERE told = 0`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE subscription ADD COLUMN ended TEXT`
  yield* sql`ALTER TABLE thread_turn ADD COLUMN started_by_harness INTEGER NOT NULL DEFAULT 0`
})

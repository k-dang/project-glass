import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_reviews ADD COLUMN hotspots TEXT NOT NULL DEFAULT '[]'`
  yield* sql`ALTER TABLE agent_reviews ADD COLUMN low_attention TEXT NOT NULL DEFAULT '[]'`
})

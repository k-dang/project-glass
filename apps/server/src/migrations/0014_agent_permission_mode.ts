import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent ADD COLUMN permission_mode TEXT`
  yield* sql`UPDATE agent SET permission_mode = 'default' WHERE engine = 'claude-code'`
})

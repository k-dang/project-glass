import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent ADD COLUMN sandbox_provider TEXT`
  yield* sql`ALTER TABLE agent ADD COLUMN sandbox TEXT`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_reviews DROP COLUMN session`
  yield* sql`ALTER TABLE thread ADD COLUMN review_checkout TEXT`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`DROP TABLE agent_review_follow_ups`
  yield* sql`ALTER TABLE agent_reviews ADD COLUMN agent_id TEXT`
  yield* sql`ALTER TABLE agent ADD COLUMN review_brief TEXT`
})

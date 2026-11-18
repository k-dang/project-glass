import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation ADD COLUMN branch TEXT`
  // Each placement checked out a branch named after the Conversation; review checkouts are detached.
  yield* sql`UPDATE conversation SET branch = name WHERE review_brief IS NULL`
})

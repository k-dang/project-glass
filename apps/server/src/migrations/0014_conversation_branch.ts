import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation ADD COLUMN branch TEXT`
  yield* sql`UPDATE conversation SET branch = name WHERE review_brief IS NULL`
})

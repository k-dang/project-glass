import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE global_conversation RENAME TO global_chat`
  yield* sql`ALTER TABLE past_global_conversation RENAME TO past_chat`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE INDEX thread_turn_running ON thread_turn (thread_id) WHERE ended IS NULL`
  yield* sql`UPDATE subscription SET last_told = NULL`
})

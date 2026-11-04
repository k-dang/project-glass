import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`CREATE INDEX activity_login_kind_time ON activity(lower(login), kind, occurred_at)`
})

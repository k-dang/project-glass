import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE queued_pull_request ADD COLUMN base TEXT`
  yield* sql`ALTER TABLE queued_pull_request ADD COLUMN head TEXT`
})

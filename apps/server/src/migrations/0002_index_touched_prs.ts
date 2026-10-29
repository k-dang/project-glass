import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE INDEX activity_login_pr
    ON activity(lower(login), json_extract(payload, '$.pullRequest'))
  `
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE activity
    SET payload = json_set(
      json_extract(payload, '$.kind'),
      '$.pullRequest',
      json_object(
        'ref', json(json_extract(payload, '$.pullRequest')),
        'title', json_extract(payload, '$.title'),
        'revision', json(json_extract(payload, '$.revision'))
      )
    )
    WHERE json_type(payload, '$.kind') = 'object'
  `

  yield* sql`DROP INDEX activity_login_pr`

  yield* sql`
    CREATE INDEX activity_login_pr
    ON activity(lower(login), json_extract(payload, '$.pullRequest.ref'))
  `
})

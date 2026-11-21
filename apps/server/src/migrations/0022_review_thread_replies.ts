import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE activity SET payload = json_set(
      json_remove(payload, '$.discussionId'),
      '$.reviewThreadId', json_extract(payload, '$.discussionId')
    )
    WHERE kind = 'ReplySent' AND json_type(payload, '$.discussionId') IS NOT NULL
  `
})

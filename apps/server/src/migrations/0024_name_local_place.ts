import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE activity
    SET payload = json_set(payload, '$.machine', 'local')
    WHERE kind = 'AgentStarted' AND json_extract(payload, '$.machine') = 'this-mac'
  `
})

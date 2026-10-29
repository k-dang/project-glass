import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent ADD COLUMN model TEXT`
  yield* sql`ALTER TABLE agent ADD COLUMN effort TEXT`

  yield* sql`
    UPDATE agent_turn_part SET part = json_set(part, '$.parentToolCallId', json('null'))
    WHERE json_extract(part, '$._tag') = 'ToolCall'
  `
})

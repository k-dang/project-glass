import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent ADD COLUMN turn_seen_at TEXT`

  yield* sql`
    UPDATE agent SET turn_seen_at = (
      SELECT MAX(json_extract(t.ended, '$.at')) FROM agent_turn t WHERE t.agent_id = agent.id
    )
  `
})

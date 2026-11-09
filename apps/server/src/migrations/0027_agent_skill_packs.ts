import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE agent_skill_pack (
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL,
      pin_id INTEGER NOT NULL,
      PRIMARY KEY (agent_id, name)
    )
  `
})

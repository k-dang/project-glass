import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE global_conversation (
      id TEXT PRIMARY KEY,
      engine TEXT NOT NULL,
      model TEXT,
      effort TEXT
    )
  `

  yield* sql`ALTER TABLE agent_turn ADD COLUMN context TEXT`
  yield* sql`ALTER TABLE agent_queued_message ADD COLUMN context TEXT`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_turn ADD COLUMN images TEXT NOT NULL DEFAULT '[]'`

  yield* sql`
    CREATE TABLE agent_queued_message (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      message TEXT NOT NULL,
      images TEXT NOT NULL
    )
  `

  yield* sql`CREATE INDEX agent_queued_message_by_agent ON agent_queued_message (agent_id, position)`

  yield* sql`
    CREATE TABLE agent_unsent_message (
      agent_id TEXT PRIMARY KEY,
      message TEXT NOT NULL,
      images TEXT NOT NULL
    )
  `
})

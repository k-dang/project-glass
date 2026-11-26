import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE event (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      pull_request TEXT NOT NULL,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX event_pull_request ON event (pull_request, id)`
  yield* sql`CREATE INDEX event_occurred_at ON event (occurred_at)`
})

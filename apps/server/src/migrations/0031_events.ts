import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE event (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      once TEXT,
      payload TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX event_subject ON event (source, subject, id)`
  yield* sql`CREATE UNIQUE INDEX event_once ON event (source, once) WHERE once IS NOT NULL`
  yield* sql`CREATE INDEX event_occurred_at ON event (occurred_at)`
})

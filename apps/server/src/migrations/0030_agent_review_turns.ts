import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_reviews DROP COLUMN session`
  yield* sql`ALTER TABLE thread ADD COLUMN review_checkout TEXT`
  yield* sql`
    CREATE TABLE agent_review_run (
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      number INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      base TEXT NOT NULL,
      head TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      runner TEXT NOT NULL,
      background INTEGER NOT NULL,
      diff TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    )
  `
})

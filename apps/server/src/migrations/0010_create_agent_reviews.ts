import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE agent_reviews (
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      base TEXT NOT NULL,
      head TEXT NOT NULL,
      written_at TEXT NOT NULL,
      content TEXT NOT NULL,
      folded TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number)
    )
  `
})

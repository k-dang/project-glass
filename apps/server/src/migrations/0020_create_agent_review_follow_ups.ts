import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE agent_review_follow_ups (
      owner TEXT NOT NULL COLLATE NOCASE,
      repo TEXT NOT NULL COLLATE NOCASE,
      number INTEGER NOT NULL,
      position INTEGER NOT NULL,
      message TEXT NOT NULL,
      answer TEXT NOT NULL,
      suggested_drafts TEXT NOT NULL,
      PRIMARY KEY (owner, repo, number, position)
    )
  `
})

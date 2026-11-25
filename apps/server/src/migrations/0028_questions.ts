import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE question (
      id TEXT PRIMARY KEY,
      asker TEXT NOT NULL,
      agent_id TEXT,
      notify_thread_id TEXT,
      question TEXT NOT NULL,
      choices TEXT NOT NULL,
      asked_at TEXT NOT NULL,
      outcome TEXT,
      delivering INTEGER NOT NULL DEFAULT 0,
      told INTEGER NOT NULL DEFAULT 0
    )
  `
  yield* sql`
    CREATE INDEX question_open ON question (asked_at) WHERE outcome IS NULL OR delivering = 1
  `
  yield* sql`
    CREATE INDEX question_by_agent ON question (agent_id, told) WHERE agent_id IS NOT NULL
  `
  yield* sql`
    CREATE INDEX question_untold ON question (notify_thread_id)
    WHERE told = 0 AND outcome IS NOT NULL
  `
})

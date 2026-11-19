import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE feedback_note (
      owner TEXT NOT NULL,
      id TEXT NOT NULL,
      path TEXT NOT NULL,
      side TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      code TEXT NOT NULL,
      changes_id TEXT NOT NULL,
      text TEXT NOT NULL,
      staged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner, id)
    )
  `
  yield* sql`
    INSERT INTO feedback_note
      (owner, id, path, side, start_line, end_line, code, changes_id, text, staged)
    SELECT 'conversation:' || conversation_id, id, path, side, start_line, end_line, code,
      changes_id, text, staged
    FROM conversation_feedback_note ORDER BY rowid
  `
  yield* sql`DROP TABLE conversation_feedback_note`
})

import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE feedback_note_next (
      owner TEXT NOT NULL,
      id TEXT NOT NULL,
      note TEXT NOT NULL,
      staged INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (owner, id)
    )
  `
  yield* sql`
    INSERT INTO feedback_note_next (owner, id, note, staged)
    SELECT owner, id,
      json_object(
        '_tag', 'LineNote', 'id', id, 'path', path, 'side', side, 'start', start_line,
        'end', end_line, 'code', code, 'changesId', changes_id, 'text', text
      ),
      staged
    FROM feedback_note ORDER BY rowid
  `
  yield* sql`DROP TABLE feedback_note`
  yield* sql`ALTER TABLE feedback_note_next RENAME TO feedback_note`
})

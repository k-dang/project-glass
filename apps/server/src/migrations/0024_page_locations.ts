import { Effect } from "effect"
import { SqlClient } from "effect/sql"

const located = (note: string) => `
  CASE WHEN json_extract(${note}, '$._tag') = 'PageNote'
    THEN json_set(
      json_remove(${note}, '$.path'),
      '$.page',
      json_object('_tag', 'FilePage', 'path', replace(json_extract(${note}, '$.path'), '\\', '/'))
    )
    ELSE json(${note})
  END`

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql.unsafe(
    `UPDATE feedback_note SET note = ${located("note")} WHERE json_extract(note, '$._tag') = 'PageNote'`,
  )

  for (const table of ["thread_turn", "thread_queued_message"])
    yield* sql.unsafe(`
      UPDATE ${table} SET feedback = (
        SELECT json_group_array(json(${located("value")})) FROM json_each(${table}.feedback)
      )
      WHERE EXISTS (
        SELECT 1 FROM json_each(${table}.feedback) WHERE json_extract(value, '$._tag') = 'PageNote'
      )
    `)
})

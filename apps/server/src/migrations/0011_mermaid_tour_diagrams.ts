import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// Tour diagrams became Mermaid source; saved node-and-edge diagrams can't be read as one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE tours SET content = json_set(
      json_remove(content, '$.diagram'),
      '$.chapters',
      (SELECT json_group_array(json_remove(chapter.value, '$.diagram'))
        FROM json_each(content, '$.chapters') AS chapter)
    )
    WHERE json_type(content, '$.chapters') = 'array'
  `
})

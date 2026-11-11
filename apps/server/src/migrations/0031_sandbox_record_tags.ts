import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE agent
    SET sandbox = CASE
      WHEN json_extract(sandbox, '$.ready') = 0
        THEN json_remove(json_set(sandbox, '$._tag', 'Building'), '$.ready')
      WHEN json_type(sandbox, '$.gone') IS NOT NULL
        THEN json_remove(
          json_set(sandbox, '$._tag', 'Gone', '$.reason', json_extract(sandbox, '$.gone')),
          '$.ready',
          '$.gone'
        )
      ELSE json_remove(json_set(sandbox, '$._tag', 'Ready'), '$.ready', '$.gone')
    END
    WHERE sandbox IS NOT NULL
  `
})

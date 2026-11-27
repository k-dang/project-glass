import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE thread_turn ADD COLUMN unprompted INTEGER NOT NULL DEFAULT 0`
  yield* sql`
    UPDATE thread_turn SET unprompted = 1
    WHERE json_extract(context, '$._tag') = 'BackgroundWorkEnded'
  `
})

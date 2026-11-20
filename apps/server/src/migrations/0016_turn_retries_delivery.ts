import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation_turn ADD COLUMN retries_delivery INTEGER NOT NULL DEFAULT 0`
  yield* sql`
    UPDATE conversation_turn SET retries_delivery = 1
    WHERE json_extract(context, '$._tag') = 'GlobalConversationUpdate'
  `
})

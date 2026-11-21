import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE conversation ADD COLUMN kept_going_at TEXT`
  yield* sql`
    UPDATE conversation SET kept_going_at = COALESCE(
      (
        SELECT MAX(sent_at) FROM conversation_turn
        WHERE conversation_id = conversation.id
          AND (context IS NULL OR json_extract(context, '$._tag') IN ('PullRequest', 'Conversation'))
      ),
      created_at
    )
  `
})

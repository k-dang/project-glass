import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const forgetStartedWork = (sql: SqlClient.SqlClient, conversationId: string) =>
  Effect.all(
    [
      sql`DELETE FROM started_conversation WHERE conversation_id = ${conversationId} OR started_by = ${conversationId}`,
      sql`DELETE FROM started_agent_review WHERE started_by = ${conversationId}`,
    ],
    { discard: true },
  )

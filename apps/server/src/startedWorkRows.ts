import { Effect } from "effect"
import type { SqlClient } from "effect/sql"

export const forgetStartedWork = (sql: SqlClient.SqlClient, threadId: string) =>
  Effect.all(
    [
      sql`DELETE FROM started_thread WHERE thread_id = ${threadId} OR started_by = ${threadId}`,
      sql`DELETE FROM started_agent_review WHERE started_by = ${threadId}`,
    ],
    { discard: true },
  )

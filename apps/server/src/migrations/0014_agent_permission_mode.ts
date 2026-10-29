import { Effect } from "effect"
import { SqlClient } from "effect/sql"

// `null` is for programs without Permission modes, so Claude Code Agents made before them start
// asking in `default`, the mode that asks the most.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent ADD COLUMN permission_mode TEXT`
  yield* sql`UPDATE agent SET permission_mode = 'default' WHERE engine = 'claude-code'`
})

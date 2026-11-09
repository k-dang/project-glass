import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    UPDATE global_conversation SET model = NULL, effort = NULL WHERE engine != 'pi'
  `
  yield* sql`ALTER TABLE global_conversation DROP COLUMN engine`
})

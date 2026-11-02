import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // The last journal entry of a Sandbox's agent host saved here, so a relaunch asks only for later ones.
  yield* sql`ALTER TABLE agent ADD COLUMN journal_saved INTEGER NOT NULL DEFAULT 0`
})

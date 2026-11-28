import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE subscription RENAME COLUMN thread_id TO subscriber`
  yield* sql`DROP INDEX subscription_thread`
  yield* sql`CREATE INDEX subscription_subscriber ON subscription (subscriber)`
})

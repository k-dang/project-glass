import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE agent_reviews DROP COLUMN session`
  yield* sql`DELETE FROM agent_reviews WHERE thread_id IS NULL`
  yield* sql`ALTER TABLE thread ADD COLUMN reviewed_revision TEXT`
  yield* sql`
    UPDATE thread SET reviewed_revision = json_object(
      'pullRequest', json_object('owner', a.owner, 'repo', a.repo, 'number', a.number),
      'revision', json_object('base', a.base, 'head', a.head)
    )
    FROM agent_reviews a WHERE a.thread_id = thread.id
  `
})

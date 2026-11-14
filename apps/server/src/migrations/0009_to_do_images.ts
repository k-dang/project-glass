import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE to_do_image (
      id INTEGER PRIMARY KEY,
      to_do_id INTEGER NOT NULL,
      file_name TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      thumbnail_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `

  yield* sql`CREATE INDEX to_do_image_to_do_id ON to_do_image (to_do_id)`
})

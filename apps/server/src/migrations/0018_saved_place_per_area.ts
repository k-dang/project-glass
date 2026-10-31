import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE saved_place_per_area (
      area TEXT PRIMARY KEY,
      destination TEXT NOT NULL,
      saved_at TEXT NOT NULL
    )
  `
  yield* sql`
    INSERT INTO saved_place_per_area (area, destination, saved_at)
    SELECT json_extract(destination, '$.area'), destination, saved_at FROM saved_place
  `
  yield* sql`DROP TABLE saved_place`
  yield* sql`ALTER TABLE saved_place_per_area RENAME TO saved_place`
})

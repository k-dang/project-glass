import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE skill_pack_pin (
      id INTEGER PRIMARY KEY,
      owner TEXT NOT NULL,
      repo TEXT NOT NULL,
      path TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      UNIQUE (owner, repo, path, commit_sha)
    )
  `

  yield* sql`
    CREATE TABLE skill_pack_skill (
      pin_id INTEGER NOT NULL,
      directory TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      PRIMARY KEY (pin_id, directory)
    )
  `

  yield* sql`
    CREATE TABLE skill_pack_file (
      pin_id INTEGER NOT NULL,
      path TEXT NOT NULL,
      blob_sha TEXT NOT NULL,
      executable INTEGER NOT NULL,
      contents BLOB NOT NULL,
      PRIMARY KEY (pin_id, path)
    )
  `

  yield* sql`
    CREATE TABLE skill_pack (
      name TEXT PRIMARY KEY,
      ref TEXT,
      pin_id INTEGER NOT NULL
    )
  `
})

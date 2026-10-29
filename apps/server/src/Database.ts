import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-node"
import { Effect, FileSystem, Layer } from "effect"
import { SqlClient } from "effect/sql"
import { dirname, join } from "node:path"
import { migrationLoader } from "./Migrations"
import { ServerConfig } from "./ServerConfig"

const migrations = SqliteMigrator.layer({
  loader: migrationLoader,
})

const synchronousNormal = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    yield* sql`PRAGMA synchronous = NORMAL`
  }),
)

export const DatabaseLive = Layer.merge(synchronousNormal, migrations).pipe(
  Layer.provideMerge(
    Layer.unwrap(
      Effect.gen(function* () {
        const { dataDirectory } = yield* ServerConfig
        const filename = join(dataDirectory, "glass.db")
        const fs = yield* FileSystem.FileSystem

        yield* fs.makeDirectory(dirname(filename), { recursive: true })

        return SqliteClient.layer({ filename })
      }),
    ),
  ),
)

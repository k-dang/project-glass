import { Effect, type FileSystem } from "effect"
import { randomUUID } from "node:crypto"
import { dirname } from "node:path"

export const writeDataFile = Effect.fnUntraced(function* (
  fs: FileSystem.FileSystem,
  path: string,
  contents: string,
) {
  yield* fs.makeDirectory(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`

  yield* Effect.gen(function* () {
    yield* fs.writeFileString(temporary, contents, { mode: 0o600 })
    yield* fs.rename(temporary, path)
  }).pipe(Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)))
})

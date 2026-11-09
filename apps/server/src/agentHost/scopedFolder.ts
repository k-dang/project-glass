import { Effect, FileSystem } from "effect"

export const scopedFolder = (folder: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem

    yield* Effect.acquireRelease(fs.makeDirectory(folder, { recursive: true }), () =>
      fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
    )

    return folder
  })

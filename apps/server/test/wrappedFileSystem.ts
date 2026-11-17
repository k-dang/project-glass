import { NodeFileSystem } from "@effect/platform-node"
import { Deferred, Effect, FileSystem, Layer } from "effect"

export const wrappedFileSystem = (
  wrap: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      return FileSystem.FileSystem.of({ ...fs, ...wrap(fs) })
    }),
  ).pipe(Layer.provide(NodeFileSystem.layer))

export const meeting = (size: number) =>
  Effect.gen(function* () {
    const everyone = yield* Deferred.make<void>()
    let arrived = 0

    return Effect.suspend(() => {
      arrived++

      return arrived === size ? Deferred.succeed(everyone, undefined) : Effect.void
    }).pipe(Effect.andThen(Deferred.await(everyone)))
  })

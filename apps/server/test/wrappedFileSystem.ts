import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem, Layer } from "effect"

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

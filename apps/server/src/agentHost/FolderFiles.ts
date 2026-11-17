import {
  BinaryFile,
  type ConversationFile,
  FileTooLarge,
  ImageFile,
  TextFile,
} from "@glass/contracts"
import { Context, Effect, FileSystem, Layer } from "effect"
import { extname, isAbsolute, join, relative, sep } from "node:path"
import { failure, type HostConversationError } from "./protocol"

const MAX_FILE_BYTES = 10_000_000

const imageTypes = new Map([
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
])

const decoder = new TextDecoder("utf-8", { fatal: true })

const textOf = (bytes: Uint8Array) => {
  if (bytes.includes(0)) return null

  try {
    return decoder.decode(bytes)
  } catch {
    return null
  }
}

const isInside = (root: string, path: string) => {
  const inside = relative(root, path)

  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
}

/** Files in a Conversation's folder, whether git tracks them or not. */
export class FolderFiles extends Context.Service<
  FolderFiles,
  {
    /** The paths that name a file in the folder, kept in order. */
    readonly existing: (
      folder: string,
      paths: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<string>, HostConversationError>
    /** Refuses a path that leaves the folder, through `..` or a symlink. */
    readonly read: (
      folder: string,
      path: string,
    ) => Effect.Effect<ConversationFile, HostConversationError>
  }
>()("@glass/server/agentHost/FolderFiles") {
  static readonly layer = Layer.effect(
    FolderFiles,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const fileIn = Effect.fnUntraced(function* (root: string, path: string) {
        const file = yield* fs.realPath(join(root, path))

        if (!isInside(root, file)) return yield* Effect.fail(`${path} leaves the folder`)

        const info = yield* fs.stat(file)

        if (info.type !== "File") return yield* Effect.fail(`${path} isn't a file`)

        return { file, size: info.size }
      })

      return FolderFiles.of({
        existing: (folder, paths) =>
          fs.realPath(folder).pipe(
            Effect.flatMap((root) =>
              Effect.filter(
                paths,
                (path) =>
                  fileIn(root, path).pipe(
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  ),
                { concurrency: 16 },
              ),
            ),
            failure("Couldn't look for files in the Conversation's folder."),
          ),
        read: (folder, path) =>
          Effect.gen(function* () {
            const { file, size } = yield* fileIn(yield* fs.realPath(folder), path)

            if (size > MAX_FILE_BYTES) return FileTooLarge.make({})

            const bytes = yield* fs.readFile(file)
            const mediaType = imageTypes.get(extname(file).toLowerCase())

            if (mediaType !== undefined)
              return ImageFile.make({ mediaType, data: Buffer.from(bytes).toString("base64") })

            const text = textOf(bytes)

            return text === null ? BinaryFile.make({}) : TextFile.make({ text })
          }).pipe(failure(`Couldn't read ${path} in the Conversation's folder.`)),
      })
    }),
  )
}

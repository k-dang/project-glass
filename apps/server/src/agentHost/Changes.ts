import {
  BinaryFile,
  ChangedFile,
  type ChangeType,
  EmptyFile,
  type FilePatch,
  NoTextChanges,
  PatchTooLarge,
  TextPatch,
} from "@glass/contracts"
import { Context, Effect, FileSystem, Layer } from "effect"
import { join } from "node:path"
import { Git } from "../git"
import { HostAgentError } from "./protocol"

const MAX_PATCH_CHARS = 500_000

const diffOptions = [
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--find-renames",
]

interface Summary {
  readonly status: string
  readonly path: string
  readonly previousPath: string | null
  readonly additions: number | null
  readonly deletions: number | null
}

/** Reads `git diff --raw --numstat -z`, whose numstat records follow the raw ones in the same order. */
const readSummary = (output: string): ReadonlyArray<Summary> => {
  const fields = output.split("\0")
  const files: Array<Omit<Summary, "additions" | "deletions">> = []
  const counts: Array<Pick<Summary, "additions" | "deletions">> = []
  let next = 0

  while (next < fields.length) {
    const field = fields[next++]!

    if (field === "") continue

    if (field.startsWith(":")) {
      const status = field.slice(field.lastIndexOf(" ") + 1)
      const first = fields[next++]!

      files.push(
        status.startsWith("R")
          ? { status, previousPath: first, path: fields[next++]! }
          : { status, previousPath: null, path: first },
      )
    } else {
      const [added = "", deleted = "", path] = field.split("\t")

      // git leaves a rename's path empty here and names both paths in the next two fields.
      if (path === "") next += 2

      counts.push({
        additions: added === "-" ? null : Number(added),
        deletions: deleted === "-" ? null : Number(deleted),
      })
    }
  }

  return files.map((file, index) => ({ ...file, ...counts[index]! }))
}

const changeType = (status: string): ChangeType => {
  if (status.startsWith("A")) return "added"

  if (status.startsWith("D")) return "deleted"

  return status.startsWith("R") ? "renamed" : "modified"
}

const filePatch = (summary: Summary, patch: string): FilePatch => {
  if (summary.additions === null) return BinaryFile.make({})

  const start = patch.search(/^@@ /m)

  if (start === -1)
    return summary.status === "A" || summary.status === "D"
      ? EmptyFile.make({})
      : NoTextChanges.make({})

  const hunks = patch.slice(start).replace(/\n$/, "")

  return hunks.length > MAX_PATCH_CHARS ? PatchTooLarge.make({}) : TextPatch.make({ hunks })
}

const failure =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, cause)),
      Effect.mapError(() => new HostAgentError({ message })),
    )

export class Changes extends Context.Service<
  Changes,
  {
    readonly since: (
      folder: string,
      baseRef: string,
    ) => Effect.Effect<ReadonlyArray<ChangedFile>, HostAgentError>
    readonly uncommitted: (folder: string) => Effect.Effect<boolean, HostAgentError>
  }
>()("@glass/server/agentHost/Changes") {
  static readonly layer = Layer.effect(
    Changes,
    Effect.gen(function* () {
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem

      const workingTreeSnapshot = Effect.fnUntraced(function* (folder: string) {
        const index = yield* git.run(folder, [
          "rev-parse",
          "--path-format=absolute",
          "--git-path",
          "index",
        ])

        const scratchIndex = { GIT_INDEX_FILE: join(yield* fs.makeTempDirectoryScoped(), "index") }

        if (yield* fs.exists(index)) yield* fs.copyFile(index, scratchIndex.GIT_INDEX_FILE)
        yield* git.run(folder, ["add", "--all"], scratchIndex)

        return yield* git.run(folder, ["write-tree"], scratchIndex)
      })

      return Changes.of({
        since: (folder, baseRef) =>
          Effect.gen(function* () {
            const forkPoint = yield* git.run(folder, ["merge-base", "HEAD", baseRef])
            const tree = yield* workingTreeSnapshot(folder)

            const [summary, patch] = yield* Effect.all(
              [
                git.runUntrimmed(folder, [
                  "diff",
                  ...diffOptions,
                  "--raw",
                  "--numstat",
                  "-z",
                  forkPoint,
                  tree,
                  "--",
                ]),
                git.runUntrimmed(folder, ["diff", ...diffOptions, forkPoint, tree, "--"]),
              ],
              { concurrency: "unbounded" },
            )

            const files = readSummary(summary)

            const patches = patch
              .split(/^(?=diff --git )/m)
              .filter((chunk) => chunk.startsWith("diff --git "))

            if (patches.length !== files.length)
              return yield* Effect.fail("git's patch and summary name different files")

            return files.map(
              (file, index) =>
                new ChangedFile({
                  path: file.path,
                  previousPath: file.previousPath,
                  changeType: changeType(file.status),
                  additions: file.additions ?? 0,
                  deletions: file.deletions ?? 0,
                  patch: filePatch(file, patches[index]!),
                }),
            )
          }).pipe(Effect.scoped, failure("Couldn't read the Agent's changes.")),
        uncommitted: (folder) =>
          git.run(folder, ["status", "--porcelain"]).pipe(
            Effect.map((status) => status !== ""),
            failure("Couldn't check the Agent's folder for changes."),
          ),
      })
    }),
  )
}

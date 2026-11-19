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
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { Git } from "./git"

export class ChangesFailed extends Schema.TaggedError<ChangesFailed>()("ChangesFailed", {
  cause: Schema.Unknown,
}) {}

const failed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.mapError((cause) => new ChangesFailed({ cause })))

const encodeFiles = Schema.encodeSync(Schema.Array(ChangedFile))

export const changesId = (files: ReadonlyArray<ChangedFile>) =>
  createHash("sha256")
    .update(JSON.stringify(encodeFiles(files)))
    .digest("hex")

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

      // WARNING: git's -z numstat leaves a rename's path empty and names both paths in the next two fields.
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

export class Changes extends Context.Service<
  Changes,
  {
    readonly since: (
      folder: string,
      baseRef: string,
    ) => Effect.Effect<ReadonlyArray<ChangedFile>, ChangesFailed>
    readonly uncommitted: (folder: string) => Effect.Effect<boolean, ChangesFailed>
    readonly branch: (folder: string) => Effect.Effect<string | null, ChangesFailed>
    readonly files: (folder: string) => Effect.Effect<ReadonlyArray<string>, ChangesFailed>
  }
>()("@glass/server/Changes") {
  static readonly layer = Layer.effect(
    Changes,
    Effect.gen(function* () {
      const git = yield* Git
      const fs = yield* FileSystem.FileSystem

      const workingTreeSnapshot = Effect.fnUntraced(function* (folder: string) {
        const [index, scratch] = yield* Effect.all(
          [
            git.run(folder, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
            fs.makeTempDirectoryScoped(),
          ],
          { concurrency: "unbounded" },
        )

        const scratchIndex = { GIT_INDEX_FILE: join(scratch, "index") }

        if (yield* fs.exists(index)) yield* fs.copyFile(index, scratchIndex.GIT_INDEX_FILE)
        yield* git.run(folder, ["add", "--all"], scratchIndex)

        return yield* git.run(folder, ["write-tree"], scratchIndex)
      }, Effect.scoped)

      return Changes.of({
        since: (folder, baseRef) =>
          Effect.gen(function* () {
            const [forkPoint, tree] = yield* Effect.all(
              [git.run(folder, ["merge-base", "HEAD", baseRef]), workingTreeSnapshot(folder)],
              { concurrency: "unbounded" },
            )

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
          }).pipe(failed),
        uncommitted: (folder) =>
          git.run(folder, ["status", "--porcelain"]).pipe(
            Effect.map((status) => status !== ""),
            failed,
          ),
        branch: (folder) =>
          git.run(folder, ["branch", "--show-current"]).pipe(
            Effect.map((branch) => (branch === "" ? null : branch)),
            failed,
          ),
        files: (folder) =>
          git
            .runUntrimmed(folder, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
            .pipe(
              Effect.map((listed) => [
                ...new Set(listed.split("\0").filter((path) => path !== "")),
              ]),
              failed,
            ),
      })
    }),
  )
}

import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { ChangedFile, TextPatch } from "@glass/contracts"
import { Effect, Layer } from "effect"
import { writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn } from "../../test/gitRepositories"
import { overlappingGit } from "../../test/overlappingGit"
import { Git } from "../git"
import { Changes } from "./Changes"

const changesWith = <R>(git: Layer.Layer<Git, never, R>) =>
  Changes.layer.pipe(Layer.provide(git), Layer.provideMerge(NodeServices.layer))

const ChangesLive = changesWith(Git.layer)

const temporaryFolder = Effect.promise(() => mkdtemp(join(tmpdir(), "glass-changes-")))

const branchWithWork = Effect.gen(function* () {
  const folder = yield* temporaryFolder
  const write = (path: string, text: string) => writeFileSync(join(folder, path), text)

  gitIn(folder, "init", "--quiet", "--initial-branch=main")
  write("notes.md", "start\n")
  write("plan.md", "plan\n")
  gitIn(folder, "add", ".")
  gitIn(folder, "commit", "--quiet", "-m", "Start")
  gitIn(folder, "switch", "--quiet", "-c", "work")
  write("notes.md", "committed\n")
  gitIn(folder, "commit", "--quiet", "-am", "Work")
  gitIn(folder, "switch", "--quiet", "main")
  write("plan.md", "moved on\n")
  gitIn(folder, "commit", "--quiet", "-am", "Main")
  gitIn(folder, "switch", "--quiet", "work")
  write("notes.md", "staged\n")
  gitIn(folder, "add", "notes.md")
  write("notes.md", "unstaged\n")
  write("new.md", "new\n")

  return folder
})

it.effect(
  "snapshots the working tree, staged or not, while it finds the fork point, without touching the index",
  () =>
    Effect.gen(function* () {
      const folder = yield* branchWithWork
      const index = () => gitIn(folder, "ls-files", "--stage")
      const before = index()

      const changes = yield* Changes

      assert.deepStrictEqual(yield* changes.since(folder, "main"), [
        new ChangedFile({
          path: "new.md",
          previousPath: null,
          changeType: "added",
          additions: 1,
          deletions: 0,
          patch: TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+new" }),
        }),
        new ChangedFile({
          path: "notes.md",
          previousPath: null,
          changeType: "modified",
          additions: 1,
          deletions: 1,
          patch: TextPatch.make({ hunks: "@@ -1 +1 @@\n-start\n+unstaged" }),
        }),
      ])
      assert.equal(index(), before)
    }).pipe(Effect.provide(changesWith(overlappingGit(["merge-base", "rev-parse"])))),
)

it.effect("lists a file in a merge conflict once", () =>
  Effect.gen(function* () {
    const folder = yield* temporaryFolder
    const write = (text: string) => writeFileSync(join(folder, "notes.md"), text)

    gitIn(folder, "init", "--quiet", "--initial-branch=main")
    write("start\n")
    gitIn(folder, "add", ".")
    gitIn(folder, "commit", "--quiet", "-m", "Start")
    gitIn(folder, "switch", "--quiet", "-c", "other")
    write("other\n")
    gitIn(folder, "commit", "--quiet", "-am", "Other")
    gitIn(folder, "switch", "--quiet", "main")
    write("main\n")
    gitIn(folder, "commit", "--quiet", "-am", "Main")
    yield* Effect.sync(() => {
      try {
        gitIn(folder, "merge", "--quiet", "other")
      } catch {}
    })
    writeFileSync(join(folder, "new.md"), "new\n")

    const changes = yield* Changes

    assert.deepStrictEqual(yield* changes.files(folder), ["new.md", "notes.md"])
  }).pipe(Effect.provide(ChangesLive)),
)

import { NodeServices } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { writeFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gitIn } from "../../test/gitRepositories"
import { Git } from "../git"
import { Changes } from "./Changes"

const ChangesLive = Changes.layer.pipe(
  Layer.provide(Git.layer),
  Layer.provideMerge(NodeServices.layer),
)

it.effect("lists a file in a merge conflict once", () =>
  Effect.gen(function* () {
    const folder = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "glass-changes-")))
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

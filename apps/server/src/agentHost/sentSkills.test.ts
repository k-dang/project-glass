import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Deferred, Effect, Exit, PlatformError, Scope } from "effect"
import { existsSync, statSync, writeFile } from "node:fs"
import { basename, join } from "node:path"
import { isolatedHome } from "../../test/harness"
import { wrappedFileSystem } from "../../test/wrappedFileSystem"
import { writeSentSkills } from "./sentSkills"

const text = (value: string) => new TextEncoder().encode(value)

const file = (path: string) => ({ path, executable: false, contents: text(path) })

it.live("writes each source's skills where the harness reads them, and removes them after", () =>
  Effect.gen(function* () {
    const folder = join(yield* isolatedHome, "checkout")
    const scope = yield* Scope.make()

    const [team] = yield* writeSentSkills(folder, [
      {
        name: "team",
        skills: [
          {
            name: "architect",
            files: [
              { path: "SKILL.md", executable: false, contents: text("---\n---\n") },
              { path: "bin/run.sh", executable: true, contents: text("echo hi") },
            ],
          },
        ],
      },
    ]).pipe(Scope.provide(scope), Effect.provide(NodeFileSystem.layer))

    assert.isDefined(team)
    const architect = join(team.plugin, "skills", "architect")
    assert.deepStrictEqual(team.skills, [architect])
    assert.isTrue(existsSync(join(team.plugin, ".claude-plugin", "plugin.json")))

    if (process.platform !== "win32") {
      assert.strictEqual(statSync(join(architect, "bin", "run.sh")).mode & 0o111, 0o111)
      assert.strictEqual(statSync(join(architect, "SKILL.md")).mode & 0o111, 0)
    }

    yield* Scope.close(scope, Exit.void)
    assert.isFalse(existsSync(team.plugin))
  }),
)

it.live("refuses a file that would land outside its skill's folder", () =>
  Effect.gen(function* () {
    const folder = join(yield* isolatedHome, "checkout")

    const refused = yield* writeSentSkills(folder, [
      {
        name: "team",
        skills: [
          {
            name: "architect",
            files: [{ path: "../../escape.sh", executable: false, contents: text("") }],
          },
        ],
      },
    ]).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.flip)

    assert.strictEqual(refused._tag, "HostConversationError")
  }),
)

it.live("writes independent skills together, returning them in the order they were sent", () =>
  Effect.gen(function* () {
    const folder = join(yield* isolatedHome, "checkout")

    const written = new Map(
      ["a.md", "b.md", "c.md"].map((name) => [name, Deferred.makeUnsafe<void>()]),
    )

    const finished = (name: string) => Deferred.await(written.get(name)!)

    const sources = yield* writeSentSkills(folder, [
      {
        name: "one",
        skills: [
          { name: "a", files: [file("a.md")] },
          { name: "b", files: [file("b.md")] },
        ],
      },
      { name: "two", skills: [{ name: "c", files: [file("c.md")] }] },
    ]).pipe(
      Effect.scoped,
      Effect.provide(
        wrappedFileSystem((fs) => ({
          writeFile: (path, data, options) =>
            (basename(path) === "a.md"
              ? Effect.all([finished("b.md"), finished("c.md")])
              : Effect.void
            ).pipe(
              Effect.andThen(fs.writeFile(path, data, options)),
              Effect.andThen(() => {
                const done = written.get(basename(path))

                return done === undefined ? Effect.void : Deferred.succeed(done, undefined)
              }),
            ),
        })),
      ),
    )

    assert.deepStrictEqual(
      sources.map(({ plugin, skills }) => [
        basename(plugin),
        skills.map((skill) => basename(skill)),
      ]),
      [
        ["one", ["a", "b"]],
        ["two", ["c"]],
      ],
    )
  }),
)

it.live("lets writes in flight finish before removing a failed write's output", () =>
  Effect.gen(function* () {
    const folder = join(yield* isolatedHome, "checkout")
    const slowStarted = yield* Deferred.make<() => void>()
    let inFlight = 0
    const inFlightAtRemoval: Array<number> = []

    const failed = yield* writeSentSkills(folder, [
      {
        name: "team",
        skills: [
          { name: "slow", files: [file("slow.md")] },
          { name: "broken", files: [file("broken.md")] },
        ],
      },
    ]).pipe(
      Effect.scoped,
      Effect.provide(
        wrappedFileSystem((fs) => ({
          writeFile: (path, data, options) => {
            if (basename(path) === "broken.md")
              return Deferred.await(slowStarted).pipe(
                Effect.flatMap((finishSlow) =>
                  Effect.fail(
                    PlatformError.badArgument({ module: "FileSystem", method: "writeFile" }),
                  ).pipe(Effect.ensuring(Effect.sync(finishSlow))),
                ),
              )

            if (basename(path) !== "slow.md") return fs.writeFile(path, data, options)

            return Effect.callback<void>((resume) => {
              inFlight++
              Deferred.doneUnsafe(
                slowStarted,
                Exit.succeed(() =>
                  writeFile(path, data, () => {
                    inFlight--
                    resume(Effect.void)
                  }),
                ),
              )
            })
          },
          remove: (path, options) =>
            Effect.sync(() => inFlightAtRemoval.push(inFlight)).pipe(
              Effect.andThen(fs.remove(path, options)),
            ),
        })),
      ),
      Effect.flip,
    )

    assert.strictEqual(failed._tag, "HostConversationError")
    assert.deepStrictEqual(inFlightAtRemoval, [0])
  }),
)

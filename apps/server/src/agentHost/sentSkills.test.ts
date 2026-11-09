import { NodeFileSystem } from "@effect/platform-node"
import { assert, it } from "@effect/vitest"
import { Effect, Exit, Scope } from "effect"
import { existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { isolatedHome } from "../../test/harness"
import { writeSentSkills } from "./sentSkills"

const text = (value: string) => new TextEncoder().encode(value)

it.live("writes each source's skills where the program reads them, and removes them after", () =>
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

    assert.strictEqual(refused._tag, "HostAgentError")
  }),
)

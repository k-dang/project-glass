import { assert, it } from "@effect/vitest"
import { type Agent } from "@glass/contracts"
import { Effect } from "effect"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { agentsFixture } from "../test/agentsFixture"

const skill = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nUse ${name} well.\n`

const write = (path: string, contents: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

const pi = { engine: "pi", model: null, effort: null } as const

it.live(
  "gives a Sandbox Agent the Local skills its program reads, as they are when it starts",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const dotfiles = join(f.home, "dotfiles", "skills")

      write(join(dotfiles, "grilling", "SKILL.md"), skill("grilling", "Ask hard questions."))
      mkdirSync(join(f.home, ".agents", "skills"), { recursive: true })
      symlinkSync(join(dotfiles, "grilling"), join(f.home, ".agents", "skills", "grilling"))
      write(
        join(f.home, ".pi", "agent", "skills", "notes", "deep", "SKILL.md"),
        skill("notes", "Take notes."),
      )
      write(join(f.home, ".claude", "skills", "tidy", "SKILL.md"), skill("tidy", "Tidy up."))

      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ engine: "pi" }), [
        "grilling",
        "notes",
      ])
      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ engine: "claude-code" }), ["tidy"])

      const commandsOf = (agent: Agent) =>
        f.client
          .ListAgentCommands({ agentId: agent.id })
          .pipe(Effect.map((commands) => commands.map(({ name }) => name)))

      const sandboxed = yield* f.startSandbox("Say hello", { ...pi, localSkills: true })
      const without = yield* f.startSandbox("Say hello", pi)
      const local = yield* f.start("Say hello", { ...pi, localSkills: true })

      assert.deepStrictEqual(
        [sandboxed, without, local].map(({ localSkills }) => localSkills),
        [true, false, false],
      )
      assert.deepStrictEqual(yield* commandsOf(sandboxed), ["local:deep", "local:grilling"])
      assert.deepStrictEqual(yield* commandsOf(without), [])
      assert.deepStrictEqual(yield* commandsOf(local), [])

      write(join(dotfiles, "planner", "SKILL.md"), skill("planner", "Plan the work."))
      symlinkSync(join(dotfiles, "planner"), join(f.home, ".agents", "skills", "planner"))

      assert.deepStrictEqual(yield* commandsOf(sandboxed), [
        "local:deep",
        "local:grilling",
        "local:planner",
      ])
    }),
)

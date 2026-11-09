import { assert, it } from "@effect/vitest"
import { type Agent } from "@glass/contracts"
import { Effect } from "effect"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { agentsFixture, settled } from "../test/agentsFixture"
import { skillFile } from "../test/skillFiles"

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

      write(join(dotfiles, "grilling", "SKILL.md"), skillFile("grilling", "Ask hard questions."))
      mkdirSync(join(f.home, ".agents", "skills"), { recursive: true })
      symlinkSync(join(dotfiles, "grilling"), join(f.home, ".agents", "skills", "grilling"))
      write(
        join(f.home, ".pi", "agent", "skills", "notes", "deep", "SKILL.md"),
        skillFile("notes", "Take notes."),
      )
      write(join(f.home, ".claude", "skills", "tidy", "SKILL.md"), skillFile("tidy", "Tidy up."))
      symlinkSync(join(f.home, "dotfiles", "gone"), join(f.home, ".agents", "skills", "gone"))
      symlinkSync(join(dotfiles, "gone.sh"), join(dotfiles, "grilling", "run.sh"))
      write(join(dotfiles, "grilling", "secret.txt"), "Only for me.")
      chmodSync(join(dotfiles, "grilling", "secret.txt"), 0o000)
      write(join(f.home, ".agents", "skills", "draft", "SKILL.md"), "No frontmatter yet.\n")

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

      for (const agent of [sandboxed, without, local]) yield* f.transcript(agent.id, settled(1))

      assert.deepStrictEqual(yield* commandsOf(sandboxed), ["local:deep", "local:grilling"])
      assert.deepStrictEqual(yield* commandsOf(without), [])
      assert.deepStrictEqual(yield* commandsOf(local), [])

      write(join(dotfiles, "planner", "SKILL.md"), skillFile("planner", "Plan the work."))
      symlinkSync(join(dotfiles, "planner"), join(f.home, ".agents", "skills", "planner"))

      assert.deepStrictEqual(yield* commandsOf(sandboxed), [
        "local:deep",
        "local:grilling",
        "local:planner",
      ])
    }),
)

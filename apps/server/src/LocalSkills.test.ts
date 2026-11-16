import { assert, it } from "@effect/vitest"
import { type Agent, TextPart } from "@glass/contracts"
import { Effect, Predicate } from "effect"
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
      write(
        join(f.home, ".claude", "skills", "archive", "old", "SKILL.md"),
        skillFile("old", "Claude Code doesn't look this deep."),
      )
      symlinkSync(join(f.home, "dotfiles", "gone"), join(f.home, ".agents", "skills", "gone"))
      symlinkSync(join(dotfiles, "gone.sh"), join(dotfiles, "grilling", "run.sh"))
      symlinkSync("cycle", join(f.home, ".agents", "skills", "cycle"))
      symlinkSync("cycle.sh", join(dotfiles, "grilling", "cycle.sh"))
      write(join(dotfiles, "grilling", "secret.txt"), "Only for me.")
      chmodSync(join(dotfiles, "grilling", "secret.txt"), 0o000)
      write(join(f.home, ".agents", "skills", "draft", "SKILL.md"), "No frontmatter yet.\n")

      for (const folder of [".agents", ".claude"]) {
        write(
          join(f.home, folder, "skills", "unnamed", "SKILL.md"),
          "---\ndescription: No name.\n---\n",
        )
      }

      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ engine: "pi" }), [
        "grilling",
        "notes",
      ])
      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ engine: "claude-code" }), ["tidy"])
      write(
        join(f.home, ".config", "opencode", "skills", "current", "SKILL.md"),
        skillFile("native-current", "Current OpenCode skills."),
      )
      write(
        join(f.home, ".config", "opencode", "skill", "legacy", "SKILL.md"),
        skillFile("native-legacy", "Native singular skill folder."),
      )
      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ engine: "opencode" }), [
        "grilling",
        "native-current",
        "native-legacy",
        "old",
        "tidy",
      ])

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

it.live(
  "sends each Local skill name once, from the folder pi reads first, with every file its symlinks share",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const shared = join(f.home, "dotfiles", "scripts")
      const twin = skillFile("twin", "A shared skill.")

      write(join(shared, "run.sh"), "echo hi")

      for (const name of ["plan", "review"]) {
        write(join(f.home, ".agents", "skills", name, "SKILL.md"), skillFile(name, `Do ${name}.`))
        symlinkSync(shared, join(f.home, ".agents", "skills", name, "scripts"))
      }

      symlinkSync(
        join(f.home, ".agents", "skills", "plan"),
        join(f.home, ".agents", "skills", "plan", "loop"),
      )

      for (const [folder, file] of [
        [join(f.home, ".pi", "agent", "skills"), "first.txt"],
        [join(f.home, ".agents", "skills"), "second.txt"],
      ] as const) {
        write(join(folder, "order", "SKILL.md"), skillFile("order", "Read first."))
        write(join(folder, "order", file), file)
      }

      write(join(f.home, ".pi", "agent", "skills", "twin", "SKILL.md"), twin)
      write(join(f.home, ".agents", "skills", "twin", "SKILL.md"), twin)
      symlinkSync(
        join(f.home, ".pi", "agent", "skills", "twin"),
        join(f.home, ".agents", "skills", "alias"),
      )

      const agent = yield* f.startSandbox("show the skills", { ...pi, localSkills: true })
      const [turn] = yield* f.transcript(agent.id, settled(1))

      assert.deepStrictEqual(
        turn?.parts.find((part) => Predicate.isTagged(part, "Text")),
        TextPart.make({
          text: "local/.claude-plugin/plugin.json,local/skills/order/SKILL.md,local/skills/order/first.txt,local/skills/plan/SKILL.md,local/skills/plan/scripts/run.sh,local/skills/review/SKILL.md,local/skills/review/scripts/run.sh,local/skills/twin/SKILL.md",
        }),
      )
    }),
)

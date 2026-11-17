import { assert, it } from "@effect/vitest"
import { type Conversation, TextPart } from "@glass/contracts"
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  type FileSystem,
  Layer,
  Option,
  Predicate,
} from "effect"
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { conversationsFixture, settled } from "../test/conversationsFixture"
import { isolatedHome, LAUNCH_TOKEN } from "../test/harness"
import { skillFile } from "../test/skillFiles"
import { meeting, wrappedFileSystem } from "../test/wrappedFileSystem"
import { LocalSkills } from "./LocalSkills"
import { ServerConfig } from "./ServerConfig"

const write = (path: string, contents: string) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

const pi = { harness: "pi", model: null, effort: null } as const

const localSkillsIn = Effect.fnUntraced(function* (
  home: string,
  wrap: (fs: FileSystem.FileSystem) => Partial<FileSystem.FileSystem>,
) {
  const services = yield* Layer.build(
    LocalSkills.layer.pipe(
      Layer.provide(ServerConfig.layer),
      Layer.provide(wrappedFileSystem(wrap)),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            GLASS_PORT: "0",
            GLASS_TOKEN: LAUNCH_TOKEN,
            GLASS_HOME: home,
          }),
        ),
      ),
    ),
  )

  return Context.get(services, LocalSkills)
})

it.live(
  "gives a Sandbox Conversation the Local skills its harness reads, as they are when it starts",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture
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

      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ harness: "pi" }), [
        "grilling",
        "notes",
      ])
      assert.deepStrictEqual(yield* f.client.ListLocalSkills({ harness: "claude-code" }), ["tidy"])

      const commandsOf = (conversation: Conversation) =>
        f.client
          .ListConversationCommands({ conversationId: conversation.id })
          .pipe(Effect.map((commands) => commands.map(({ name }) => name)))

      const sandboxed = yield* f.startSandbox("Say hello", { ...pi, localSkills: true })
      const without = yield* f.startSandbox("Say hello", pi)
      const local = yield* f.start("Say hello", { ...pi, localSkills: true })

      assert.deepStrictEqual(
        [sandboxed, without, local].map(({ localSkills }) => localSkills),
        [true, false, false],
      )

      for (const conversation of [sandboxed, without, local])
        yield* f.transcript(conversation.id, settled(1))

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
      const f = yield* conversationsFixture
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

      const conversation = yield* f.startSandbox("show the skills", { ...pi, localSkills: true })
      const [turn] = yield* f.transcript(conversation.id, settled(1))

      assert.deepStrictEqual(
        turn?.parts.find((part) => Predicate.isTagged(part, "Text")),
        TextPart.make({
          text: "local/.claude-plugin/plugin.json,local/skills/order/SKILL.md,local/skills/order/first.txt,local/skills/plan/SKILL.md,local/skills/plan/scripts/run.sh,local/skills/review/SKILL.md,local/skills/review/scripts/run.sh,local/skills/twin/SKILL.md",
        }),
      )
    }),
)

it.live("scans pi's skill folders together", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const folders = [join(home, ".pi", "agent", "skills"), join(home, ".agents", "skills")]
    const bothScanning = yield* meeting(2)

    write(join(folders[0]!, "plan", "SKILL.md"), skillFile("plan", "Plan."))
    write(join(folders[1]!, "review", "SKILL.md"), skillFile("review", "Review."))

    const local = yield* localSkillsIn(home, (fs) => ({
      readDirectory: (path, options) =>
        (folders.includes(path) ? bothScanning : Effect.void).pipe(
          Effect.andThen(fs.readDirectory(path, options)),
        ),
    }))

    assert.deepStrictEqual(yield* local.names("pi"), ["plan", "review"])
  }),
)

it.live("reads Local skills together, naming their folders in the order pi reads them", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const folder = join(home, ".agents", "skills")
    const laterRead = yield* Deferred.make<void>()

    write(join(folder, "a", "tool", "SKILL.md"), skillFile("alpha", "First."))
    write(join(folder, "a", "tool", "a.txt"), "a")
    write(join(folder, "b", "tool", "SKILL.md"), skillFile("beta", "Second."))
    write(join(folder, "b", "tool", "b.txt"), "b")

    const local = yield* localSkillsIn(home, (fs) => ({
      readFile: (path) =>
        path.endsWith("a.txt")
          ? Deferred.await(laterRead).pipe(Effect.andThen(fs.readFile(path)))
          : fs
              .readFile(path)
              .pipe(
                Effect.tap(() =>
                  path.endsWith("b.txt") ? Deferred.succeed(laterRead, undefined) : Effect.void,
                ),
              ),
    }))

    const source = yield* local.source("pi")

    assert.deepStrictEqual(
      Option.map(source, ({ skills }) =>
        skills.map(({ name, files }) => [name, files.map(({ path }) => path)]),
      ),
      Option.some([
        ["tool", ["SKILL.md", "a.txt"]],
        ["tool-2", ["SKILL.md", "b.txt"]],
      ]),
    )
  }),
)

it.live("reads at most 8 files or folders at once, however deep a skill goes", () =>
  Effect.gen(function* () {
    const home = yield* isolatedHome
    const skill = join(home, ".claude", "skills", "deep")
    let inFlight = 0
    let peak = 0

    write(join(skill, "SKILL.md"), skillFile("deep", "Many files."))

    for (const outer of ["1", "2", "3", "4"])
      for (const inner of ["1", "2", "3", "4"])
        for (const name of ["1", "2", "3", "4"])
          write(join(skill, outer, inner, `${name}.txt`), name)

    const counted = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.sync(() => {
        inFlight++
        peak = Math.max(peak, inFlight)
      }).pipe(
        Effect.andThen(Effect.yieldNow),
        Effect.andThen(effect),
        Effect.ensuring(Effect.sync(() => inFlight--)),
      )

    const local = yield* localSkillsIn(home, (fs) => ({
      stat: (path) => counted(fs.stat(path)),
      realPath: (path) => counted(fs.realPath(path)),
      readDirectory: (path, options) => counted(fs.readDirectory(path, options)),
      readFile: (path) => counted(fs.readFile(path)),
      readFileString: (path, encoding) => counted(fs.readFileString(path, encoding)),
    }))

    const source = yield* local.source("claude-code")

    assert.deepStrictEqual(
      Option.map(source, ({ skills }) => skills.map(({ files }) => files.length)),
      Option.some([65]),
    )
    assert.isAtMost(peak, 8)
    assert.isAbove(peak, 1)
  }),
)

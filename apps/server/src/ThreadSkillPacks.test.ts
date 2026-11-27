import { assert, it } from "@effect/vitest"
import { type Thread, TextPart } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { threadsFixture, settled } from "../test/threadsFixture"
import { ExecutableFile } from "../test/fakeRepositories"
import { skillFile } from "../test/skillFiles"

const acmeSkills = { owner: "acme", repo: "skills" }

const teamUrl = "https://github.com/acme/skills/tree/main/skills/team"

const pi = { harness: "pi", model: null, effort: null, skillPacks: ["team"] } as const

const storedPins = (home: string) => {
  const database = new DatabaseSync(join(home, ".project-glass", "glass.db"), { readOnly: true })

  try {
    return database
      .prepare("SELECT DISTINCT commit_sha FROM skill_pack_pin ORDER BY commit_sha")
      .all()
      .map(({ commit_sha }) => commit_sha)
  } finally {
    database.close()
  }
}

it.live(
  "gives a Thread the Skill packs it was created with, at their commits for its whole life",
  () =>
    Effect.gen(function* () {
      const f = yield* threadsFixture

      const first = f.github.pushRepository(acmeSkills, "main", {
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/architect/run.sh": new ExecutableFile("echo hi"),
        "skills/team/review/deep/critic/SKILL.md": skillFile("critic", "Find the flaws."),
      })

      const { source } = yield* f.client.PreviewSkillPack({ url: teamUrl })
      yield* f.client.AddSkillPack({ source, commit: first, name: "team" })

      const local = yield* f.start("show the skills", pi)
      const sandboxed = yield* f.startSandbox("show the skills", pi)

      const sentSkills = (thread: Thread) =>
        f
          .transcript(thread.id, settled(1))
          .pipe(
            Effect.map(([turn]) => turn?.parts.find((part) => Predicate.isTagged(part, "Text"))),
          )

      const commandsOf = (thread: Thread, client = f.client) =>
        client
          .ListThreadCommands({ threadId: thread.id })
          .pipe(Effect.map((commands) => commands.map(({ name }) => name)))

      for (const thread of [local, sandboxed]) {
        assert.deepStrictEqual(thread.skillPacks, [{ name: "team", commit: first }])
        assert.deepStrictEqual(
          yield* sentSkills(thread),
          TextPart.make({
            text: "team/.claude-plugin/plugin.json,team/skills/architect/SKILL.md,team/skills/architect/run.sh,team/skills/critic/SKILL.md",
          }),
        )
        assert.deepStrictEqual(yield* commandsOf(thread), ["team:architect", "team:critic"])
      }

      const second = f.github.pushRepository(acmeSkills, "main", {
        "skills/team/planner/SKILL.md": skillFile("planner", "Plan the work."),
      })

      yield* f.client.UpdateSkillPack({ name: "team", commit: second })
      const later = yield* f.start("Say hello", pi)
      yield* f.client.RemoveSkillPack({ name: "team" })

      const relaunched = yield* f.restart

      const threads = yield* relaunched
        .WatchThreads()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.deepStrictEqual(
        threads.map(({ skillPacks }) => skillPacks),
        [
          [{ name: "team", commit: second }],
          [{ name: "team", commit: first }],
          [{ name: "team", commit: first }],
        ],
      )
      assert.deepStrictEqual(yield* commandsOf(local, relaunched), [
        "team:architect",
        "team:critic",
      ])
      assert.deepStrictEqual(yield* commandsOf(later, relaunched), ["team:planner"])

      yield* relaunched.RemoveThread({ threadId: local.id })
      yield* relaunched.RemoveThread({ threadId: sandboxed.id })
      assert.deepStrictEqual(storedPins(f.home), [second])
    }),
)

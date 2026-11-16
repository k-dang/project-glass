import { assert, it } from "@effect/vitest"
import { type Conversation, TextPart } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { conversationsFixture, settled } from "../test/conversationsFixture"
import { ExecutableFile } from "../test/fakeRepositories"
import { skillFile } from "../test/skillFiles"

const acmeSkills = { owner: "acme", repo: "skills" }

const teamUrl = "https://github.com/acme/skills/tree/main/skills/team"

const pi = { engine: "pi", model: null, effort: null, skillPacks: ["team"] } as const

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
  "gives a Conversation the Skill packs it was created with, at their commits for its whole life",
  () =>
    Effect.gen(function* () {
      const f = yield* conversationsFixture

      const first = f.github.pushRepository(acmeSkills, "main", {
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/architect/run.sh": new ExecutableFile("echo hi"),
        "skills/team/review/deep/critic/SKILL.md": skillFile("critic", "Find the flaws."),
      })

      const { source } = yield* f.client.PreviewSkillPack({ url: teamUrl })
      yield* f.client.AddSkillPack({ source, commit: first, name: "team" })

      const local = yield* f.start("show the skills", pi)
      const sandboxed = yield* f.startSandbox("show the skills", pi)

      const sentSkills = (conversation: Conversation) =>
        f
          .transcript(conversation.id, settled(1))
          .pipe(
            Effect.map(([turn]) => turn?.parts.find((part) => Predicate.isTagged(part, "Text"))),
          )

      const commandsOf = (conversation: Conversation, client = f.client) =>
        client
          .ListConversationCommands({ conversationId: conversation.id })
          .pipe(Effect.map((commands) => commands.map(({ name }) => name)))

      for (const conversation of [local, sandboxed]) {
        assert.deepStrictEqual(conversation.skillPacks, [{ name: "team", commit: first }])
        assert.deepStrictEqual(
          yield* sentSkills(conversation),
          TextPart.make({
            text: "team/.claude-plugin/plugin.json,team/skills/architect/SKILL.md,team/skills/architect/run.sh,team/skills/critic/SKILL.md",
          }),
        )
        assert.deepStrictEqual(yield* commandsOf(conversation), ["team:architect", "team:critic"])
      }

      const second = f.github.pushRepository(acmeSkills, "main", {
        "skills/team/planner/SKILL.md": skillFile("planner", "Plan the work."),
      })

      yield* f.client.UpdateSkillPack({ name: "team", commit: second })
      const later = yield* f.start("Say hello", pi)
      yield* f.client.RemoveSkillPack({ name: "team" })

      const relaunched = yield* f.restart

      const conversations = yield* relaunched
        .WatchConversations()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.deepStrictEqual(
        conversations.map(({ skillPacks }) => skillPacks),
        [
          [{ name: "team", commit: first }],
          [{ name: "team", commit: first }],
          [{ name: "team", commit: second }],
        ],
      )
      assert.deepStrictEqual(yield* commandsOf(local, relaunched), [
        "team:architect",
        "team:critic",
      ])
      assert.deepStrictEqual(yield* commandsOf(later, relaunched), ["team:planner"])

      yield* relaunched.RemoveConversation({ conversationId: local.id })
      yield* relaunched.RemoveConversation({ conversationId: sandboxed.id })
      assert.deepStrictEqual(storedPins(f.home), [second])
    }),
)

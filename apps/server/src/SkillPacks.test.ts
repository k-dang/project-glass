import { assert, describe, it } from "@effect/vitest"
import {
  InvalidSkillPackName,
  Skill,
  SkillPack,
  SkillPackNameTaken,
  SkillPackNotReadable,
  SkillPackSource,
  SkillPackUpdate,
  SkippedSkill,
} from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { ExecutableFile } from "../test/fakeRepositories"
import { isolatedHome, startBackend, startSignedInBackend } from "../test/harness"
import { skillFile } from "../test/skillFiles"

const acmeSkills = { owner: "acme", repo: "skills" }

const teamUrl = "https://github.com/acme/skills/tree/main/skills/team"

const storedFiles = (home: string) => {
  const database = new DatabaseSync(join(home, ".project-glass", "glass.db"), { readOnly: true })

  try {
    return database
      .prepare(
        `SELECT pin.commit_sha AS pin, file.path, file.executable, CAST(file.contents AS TEXT) AS text
         FROM skill_pack_file AS file JOIN skill_pack_pin AS pin ON pin.id = file.pin_id
         ORDER BY pin.id, file.path`,
      )
      .all()
      .map((row) => ({ ...row }))
  } finally {
    database.close()
  }
}

describe("Skill packs", () => {
  it.live("previews a folder's skills, found recursively, with the ones it skips", () =>
    Effect.gen(function* () {
      const { client, github } = yield* startSignedInBackend

      const commit = github.pushRepository(acmeSkills, "main", {
        "README.md": "# Acme skills",
        "skills/team/UPSTREAM.md": "Copied from elsewhere.",
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/architect/notes/SKILL.md": skillFile("nested", "Never its own skill."),
        "skills/team/review/deep/critic/SKILL.md": skillFile("critic", "Find the flaws."),
        "skills/team/review/deep/critic/run.sh": new ExecutableFile("echo hi"),
        "skills/team/silent/SKILL.md": "---\nname: silent\n---\n",
        "skills/team/broken/SKILL.md": "---\nname: [broken\n---\n",
        "skills/team/bare/SKILL.md": "Just text.",
        "skills/team/unnamed/SKILL.md": "---\ndescription: No name.\n---\n",
        "skills/team/blank/SKILL.md": '---\nname: "  "\ndescription: Blank name.\n---\n',
        "skills/team/numeric/SKILL.md": "---\nname: 123\ndescription: Numeric name.\n---\n",
      })

      const preview = yield* client.PreviewSkillPack({
        url: "https://github.com/acme/skills/tree/main/skills/team",
      })

      assert.deepStrictEqual(
        preview.source,
        new SkillPackSource({ owner: "acme", repo: "skills", ref: "main", path: "skills/team" }),
      )
      assert.strictEqual(preview.commit, commit)
      assert.strictEqual(preview.suggestedName, "team")
      assert.deepStrictEqual(preview.skills, [
        new Skill({ name: "architect", description: "Shape a design." }),
        new Skill({ name: "critic", description: "Find the flaws." }),
      ])
      assert.deepStrictEqual(preview.skipped, [
        new SkippedSkill({ directory: "bare", reason: "SKILL.md has no frontmatter." }),
        new SkippedSkill({ directory: "blank", reason: "SKILL.md has no name." }),
        new SkippedSkill({
          directory: "broken",
          reason: "SKILL.md's frontmatter isn't valid YAML.",
        }),
        new SkippedSkill({ directory: "numeric", reason: "SKILL.md has no name." }),
        new SkippedSkill({ directory: "silent", reason: "SKILL.md has no description." }),
        new SkippedSkill({ directory: "unnamed", reason: "SKILL.md has no name." }),
      ])
    }),
  )

  it.live("doesn't add a single skill without a frontmatter name", () =>
    Effect.gen(function* () {
      const { client, github } = yield* startSignedInBackend

      github.pushRepository(acmeSkills, "main", {
        "grilling/SKILL.md": "---\ndescription: Ask hard questions.\n---\n",
      })

      const preview = yield* client.PreviewSkillPack({
        url: "https://github.com/acme/skills/tree/main/grilling",
      })

      assert.deepStrictEqual(preview.skills, [])
      assert.deepStrictEqual(preview.skipped, [
        new SkippedSkill({ directory: "", reason: "SKILL.md has no name." }),
      ])
      assert.instanceOf(
        yield* Effect.flip(
          client.AddSkillPack({ source: preview.source, commit: preview.commit, name: "team" }),
        ),
        SkillPackNotReadable,
      )
      assert.deepStrictEqual(yield* client.ListSkillPacks(), [])
    }),
  )

  it.live("reads a repository URL's default branch and a single-skill folder as one skill", () =>
    Effect.gen(function* () {
      const { client, github } = yield* startSignedInBackend
      const grilling = { "SKILL.md": skillFile("grilling", "Ask hard questions.") }

      const trunk = github.pushRepository({ owner: "Acme", repo: "Grill" }, "trunk", grilling)
      github.pushRepository(acmeSkills, "main", { "README.md": "# Acme skills" })

      const release = github.pushRepository(acmeSkills, "release/v2", {
        "skills/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/architect/notes/SKILL.md": skillFile("nested", "Never its own skill."),
      })

      const repository = yield* client.PreviewSkillPack({
        url: "https://github.com/Acme/Grill?tab=readme-ov-file",
      })

      assert.deepStrictEqual(
        [repository.source, repository.commit, repository.suggestedName, repository.skills],
        [
          new SkillPackSource({ owner: "acme", repo: "grill", ref: null, path: "" }),
          trunk,
          "grill",
          [new Skill({ name: "grilling", description: "Ask hard questions." })],
        ],
      )

      const folder = yield* client.PreviewSkillPack({
        url: "github.com/acme/skills/tree/release/v2/skills/architect/",
      })

      assert.deepStrictEqual(
        [folder.source, folder.commit, folder.suggestedName, folder.skills],
        [
          new SkillPackSource({
            owner: "acme",
            repo: "skills",
            ref: "release/v2",
            path: "skills/architect",
          }),
          release,
          "architect",
          [new Skill({ name: "architect", description: "Shape a design." })],
        ],
      )
    }),
  )

  it.live("explains URLs and folders it can't read", () =>
    Effect.gen(function* () {
      const { client, github } = yield* startSignedInBackend

      const commit = github.pushRepository(acmeSkills, "main", {
        "docs/README.md": "No skills here.",
      })

      const problem = (url: string) =>
        client.PreviewSkillPack({ url }).pipe(
          Effect.flip,
          Effect.map((error) =>
            Predicate.isTagged(error, "InvalidSkillPackUrl") ? error._tag : error.message,
          ),
        )

      assert.deepStrictEqual(
        [
          yield* problem("https://gitlab.com/acme/skills"),
          yield* problem("https://github.com/acme/skills/blob/main/docs/README.md"),
          yield* problem("https://github.com/acme/skills/tree/main/%ZZ"),
          yield* problem("https://github.com/acme/skills/tree/main/%E0%A4"),
          yield* problem("https://github.com/acme/private-skills"),
          yield* problem("https://github.com/acme/skills/tree/nightly/skills"),
          yield* problem("https://github.com/acme/skills/tree/main/skills"),
          yield* problem("https://github.com/acme/skills/tree/main/docs"),
        ],
        [
          "InvalidSkillPackUrl",
          "InvalidSkillPackUrl",
          "InvalidSkillPackUrl",
          "InvalidSkillPackUrl",
          "GitHub couldn't find acme/private-skills, or your GitHub connection can't see it.",
          "GitHub has no branch, tag, or commit in acme/skills that this URL names.",
          `acme/skills at ${commit.slice(0, 7)} has no folder skills.`,
          `No folder in docs in acme/skills at ${commit.slice(0, 7)} has a SKILL.md.`,
        ],
      )
    }),
  )
  it.live("adds a pack under a unique name and keeps its pinned files across restarts", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()
      const signedIn = { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url }

      const commit = github.pushRepository(acmeSkills, "main", {
        "skills/team/UPSTREAM.md": "Copied from elsewhere.",
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/architect/run.sh": new ExecutableFile("echo hi"),
        "skills/team/silent/SKILL.md": "---\nname: silent\n---\n",
      })

      const team = new SkillPack({
        name: "team",
        source: new SkillPackSource({
          owner: "acme",
          repo: "skills",
          ref: "main",
          path: "skills/team",
        }),
        commit,
        updatable: true,
        skills: [new Skill({ name: "architect", description: "Shape a design." })],
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const { client } = yield* startBackend(signedIn, home)
          const { source } = yield* client.PreviewSkillPack({ url: teamUrl })

          assert.deepStrictEqual(yield* client.ListSkillPacks(), [])
          assert.deepStrictEqual(yield* client.AddSkillPack({ source, commit, name: "team" }), [
            team,
          ])

          for (const name of ["Team", "team_skills", "-team", "a".repeat(65), "local"]) {
            assert.instanceOf(
              yield* Effect.flip(client.AddSkillPack({ source, commit, name })),
              InvalidSkillPackName,
            )
          }

          assert.instanceOf(
            yield* Effect.flip(client.AddSkillPack({ source, commit, name: "team" })),
            SkillPackNameTaken,
          )
        }),
      )

      const { client } = yield* startBackend(signedIn, home)

      assert.deepStrictEqual(yield* client.ListSkillPacks(), [team])
      assert.deepStrictEqual(storedFiles(home), [
        {
          pin: commit,
          path: "architect/SKILL.md",
          executable: 0,
          text: skillFile("architect", "Shape a design."),
        },
        { pin: commit, path: "architect/run.sh", executable: 1, text: "echo hi" },
      ])
    }),
  )

  it.live("updates a pack only on confirmation, summarising what changed against its pin", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()

      const { client } = yield* startBackend(
        { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
        home,
      )

      const first = github.pushRepository(acmeSkills, "main", {
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/critic/SKILL.md": skillFile("critic", "Find the flaws."),
        "skills/team/critic/run.sh": "echo critic",
        "skills/team/scribe/SKILL.md": skillFile("scribe", "Write it down."),
        "skills/team/tidy/SKILL.md": skillFile("tidy", "Clean up."),
      })

      const { source } = yield* client.PreviewSkillPack({ url: teamUrl })
      yield* client.AddSkillPack({ source, commit: first, name: "team" })

      const commitUrl = `https://github.com/acme/skills/tree/${first.slice(0, 7)}/skills/team`
      const atCommit = yield* client.PreviewSkillPack({ url: commitUrl })

      const pinned = yield* client.AddSkillPack({
        source: atCommit.source,
        commit: atCommit.commit,
        name: "pinned",
      })

      const second = github.pushRepository(acmeSkills, "main", {
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
        "skills/team/critic/SKILL.md": skillFile("critic", "Find the flaws."),
        "skills/team/critic/run.sh": new ExecutableFile("echo critic"),
        "skills/team/scribe/SKILL.md": skillFile("scribe", "Write it all down."),
        "skills/team/planner/SKILL.md": skillFile("planner", "Plan the work."),
        "skills/team/broken/SKILL.md": "No frontmatter.",
      })

      const update = yield* client.PreviewSkillPackUpdate({ name: "team" })

      assert.deepStrictEqual(
        update,
        new SkillPackUpdate({
          name: "team",
          from: first,
          to: second,
          added: [new Skill({ name: "planner", description: "Plan the work." })],
          removed: [new Skill({ name: "tidy", description: "Clean up." })],
          changed: [
            new Skill({ name: "critic", description: "Find the flaws." }),
            new Skill({ name: "scribe", description: "Write it all down." }),
          ],
          skipped: [
            new SkippedSkill({ directory: "broken", reason: "SKILL.md has no frontmatter." }),
          ],
        }),
      )
      assert.deepStrictEqual(
        (yield* client.ListSkillPacks()).map(({ name, commit, updatable }) => [
          name,
          commit,
          updatable,
        ]),
        [
          ["pinned", first, false],
          ["team", first, true],
        ],
      )
      assert.deepStrictEqual(pinned.find(({ name }) => name === "pinned")?.updatable, false)

      const nothing = yield* client.PreviewSkillPackUpdate({ name: "pinned" })
      assert.deepStrictEqual(
        [nothing.from, nothing.to, nothing.added, nothing.removed, nothing.changed],
        [first, first, [], [], []],
      )

      const updated = yield* client.UpdateSkillPack({ name: "team", commit: second })

      assert.deepStrictEqual(
        updated.map(({ name, commit, skills }) => [
          name,
          commit,
          skills.map((packSkill) => packSkill.name),
        ]),
        [
          ["pinned", first, ["architect", "critic", "scribe", "tidy"]],
          ["team", second, ["architect", "critic", "planner", "scribe"]],
        ],
      )
      assert.deepStrictEqual([...new Set(storedFiles(home).map(({ pin }) => pin))], [first, second])
    }),
  )

  it.live("removes packs, deleting a pin's files once no pack references them", () =>
    Effect.gen(function* () {
      const home = yield* isolatedHome
      const github = yield* startFakeGitHub()

      const { client } = yield* startBackend(
        { GH_TOKEN: VIEWER.token, GLASS_GITHUB_API_URL: github.url },
        home,
      )

      const commit = github.pushRepository(acmeSkills, "main", {
        "skills/team/architect/SKILL.md": skillFile("architect", "Shape a design."),
      })

      const { source } = yield* client.PreviewSkillPack({ url: teamUrl })
      yield* client.AddSkillPack({ source, commit, name: "team" })
      yield* client.AddSkillPack({ source, commit, name: "team-copy" })

      assert.deepStrictEqual(
        (yield* client.RemoveSkillPack({ name: "team" })).map(({ name }) => name),
        ["team-copy"],
      )
      assert.deepStrictEqual(
        storedFiles(home).map(({ path }) => path),
        ["architect/SKILL.md"],
      )

      assert.deepStrictEqual(yield* client.RemoveSkillPack({ name: "team-copy" }), [])
      assert.deepStrictEqual(storedFiles(home), [])
    }),
  )
})

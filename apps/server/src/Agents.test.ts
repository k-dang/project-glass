import { assert, it } from "@effect/vitest"
import { AgentStarted, TextPatch, localPlace } from "@glass/contracts"
import { Effect, Option, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture, holding, repository, settled } from "../test/agentsFixture"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome, startSignedInBackend } from "../test/harness"

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const elsewhere = yield* isolatedHome
    const unpublished = join(elsewhere, "unpublished")
    gitIn(elsewhere, "init", "--quiet", unpublished)

    for (const path of [elsewhere, unpublished]) {
      const refused = yield* f.client.LinkLocalCheckout({ path }).pipe(Effect.flip)
      assert.equal(refused._tag, "InvalidLocalCheckout")
    }

    yield* Effect.promise(() => mkdir(join(f.clone.checkout, "src")))

    const linked = yield* f.client.LinkLocalCheckout({ path: join(f.clone.checkout, "src") })

    assert.deepStrictEqual(linked.repository, repository)
    assert.equal(linked.path, gitIn(f.clone.checkout, "rev-parse", "--show-toplevel"))

    const restarted = yield* f.restart
    const [kept] = yield* restarted.ListLocalCheckouts()
    assert.deepStrictEqual(kept?.repository, repository)
    assert.equal(kept?.path, linked.path)

    const branches = yield* restarted.ListBranches({ repository })
    assert.equal(branches.defaultBranch, "main")
    assert.sameMembers([...branches.branches], ["main", "develop"])
  }),
)

it.live("lists a Followed repository's branches from GitHub, for a Sandbox", () =>
  Effect.gen(function* () {
    const { github, client } = yield* startSignedInBackend
    const features = Array.from({ length: 150 }, (_, index) => `feature/${index}`)
    github.seedBranches(repository, {
      defaultBranch: "develop",
      branches: ["main", "develop", ...features],
    })

    assert.equal(yield* client.GetGitHubDefaultBranch({ repository }), "develop")

    const branches = yield* client.ListGitHubBranches({ repository })
    assert.sameMembers([...branches], ["main", "develop", ...features])

    const missing = yield* client
      .ListGitHubBranches({ repository: { owner: "glass-demo", repo: "nowhere" } })
      .pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")

    const missingDefault = yield* client
      .GetGitHubDefaultBranch({ repository: { owner: "glass-demo", repo: "nowhere" } })
      .pipe(Effect.flip)

    assert.equal(missingDefault._tag, "GitHubUnavailable")
  }),
)

it.live("starts an Agent in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture
    const agent = yield* f.start()
    const other = yield* f.start()
    const worktree = f.worktree(agent.name)

    assert.match(agent.name, /^agent\//)
    assert.notEqual(other.name, agent.name)
    assert.equal(gitIn(worktree, "branch", "--show-current"), agent.name)
    assert.equal(gitIn(worktree, "rev-parse", "HEAD"), f.clone.main)

    const [listed] = yield* f.client
      .WatchAgents()
      .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

    assert.deepStrictEqual(
      { id: listed?.id, place: listed?.place, repository: listed?.repository },
      { id: agent.id, place: localPlace, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      AgentStarted.make({
        agentId: agent.id,
        name: agent.name,
        repository,
        machine: "local",
        engine: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live(
  "removes an Agent's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("hold:never")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, holding)

      const clean = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(clean.uncommittedChanges, "none")

      yield* Effect.promise(() => writeFile(join(worktree, "notes.txt"), "work in progress"))
      const dirty = yield* f.client.GetRemovalWarnings({ agentId: agent.id })
      assert.equal(dirty.uncommittedChanges, "some")

      yield* f.client.RemoveAgent({ agentId: agent.id })

      assert.isFalse(existsSync(worktree))
      assert.equal(
        gitIn(f.clone.checkout, "branch", "--list", agent.name).replace("*", "").trim(),
        agent.name,
      )
      assert.lengthOf(
        yield* f.client.WatchAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
        0,
      )

      const gone = yield* f.client
        .WatchTranscript({ agentId: agent.id })
        .pipe(Stream.runHead, Effect.flip)

      assert.equal(gone._tag, "AgentNotFound")
    }),
)

it.live(
  "diffs an Agent's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture
      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))

      yield* Effect.promise(async () => {
        await writeFile(join(worktree, "committed.txt"), "done\n")
        gitIn(worktree, "add", "committed.txt")
        gitIn(
          worktree,
          "-c",
          "user.name=Agent",
          "-c",
          "user.email=agent@glass.invalid",
          "commit",
          "--quiet",
          "--no-gpg-sign",
          "-m",
          "Commit",
        )
        await writeFile(join(worktree, "staged.txt"), "staged \n")
        gitIn(worktree, "add", "staged.txt")
        await mkdir(join(worktree, "docs dir"))
        await rename(join(worktree, "README.md"), join(worktree, "docs dir", "read é.md"))
        await writeFile(join(worktree, "notes.txt"), "hello\n")
        await writeFile(join(worktree, "logo.bin"), Buffer.from([0, 1]))
      })

      const git = () => ({
        head: gitIn(worktree, "rev-parse", "HEAD"),
        branch: gitIn(worktree, "branch", "--show-current"),
        status: gitIn(worktree, "status", "--porcelain", "-uall"),
      })

      const before = git()
      const files = yield* f.client.GetAgentChanges({ agentId: agent.id })
      assert.deepStrictEqual(git(), before)
      assert.equal(before.branch, agent.name)
      assert.notEqual(before.head, f.clone.main)

      assert.deepStrictEqual(
        files.map(
          (file) =>
            `${file.changeType} ${file.previousPath === null ? "" : `${file.previousPath} → `}${file.path} +${file.additions} -${file.deletions} ${file.patch._tag}`,
        ),
        [
          "added committed.txt +1 -0 TextPatch",
          "renamed README.md → docs dir/read é.md +0 -0 NoTextChanges",
          "added logo.bin +0 -0 BinaryFile",
          "added notes.txt +1 -0 TextPatch",
          "added staged.txt +1 -0 TextPatch",
        ],
      )

      assert.deepStrictEqual(
        files.find(({ path }) => path === "staged.txt")?.patch,
        TextPatch.make({ hunks: "@@ -0,0 +1 @@\n+staged " }),
      )
    }),
)

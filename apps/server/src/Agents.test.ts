import { assert, it } from "@effect/vitest"
import { AgentStarted, nothingUnsent, TextPart, TextPatch, thisMac } from "@glass/contracts"
import { Effect, Option, Stream } from "effect"
import { existsSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { agentsFixture, lastText, pixel, repository, settled } from "../test/agentsFixture"
import { runCommands } from "../test/fakeModelProvider"
import { gitIn } from "../test/gitRepositories"
import { isolatedHome, startSignedInBackend } from "../test/harness"
import { vi } from "vite-plus/test"

vi.stubEnv("PI_OFFLINE", "1")

it.live("links a clone as the Local checkout of the GitHub repository it names, and keeps it", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})
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

    const branches = yield* client.ListGitHubBranches({ repository })
    assert.equal(branches.defaultBranch, "develop")
    assert.sameMembers([...branches.branches], ["main", "develop", ...features])

    const missing = yield* client
      .ListGitHubBranches({ repository: { owner: "glass-demo", repo: "nowhere" } })
      .pipe(Effect.flip)

    assert.equal(missing._tag, "GitHubUnavailable")
  }),
)

it.live("starts an Agent in a worktree, on a new branch it names from its base", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hello!" })
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
      { id: agent.id, place: thisMac, repository },
    )

    const { activities } = yield* f.client.ListActivity({ limit: 10 })
    assert.deepInclude(
      activities.map(({ activity }) => activity),
      AgentStarted.make({
        agentId: agent.id,
        name: agent.name,
        repository,
        machine: "this-mac",
        engine: "pi",
        message: "Say hello",
      }),
    )
  }),
)

it.live("keeps an Agent's unsent message across a relaunch until it is cleared", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hi." })
    const agent = yield* f.start()
    const unsent = { message: "Half a thought", images: [pixel] }
    yield* f.client.SaveUnsentMessage({ agentId: agent.id, ...unsent })

    const restarted = yield* f.restart
    const kept = yield* restarted.GetUnsentMessage({ agentId: agent.id })
    assert.deepStrictEqual({ message: kept.message, images: kept.images }, unsent)

    yield* restarted.SaveUnsentMessage({ agentId: agent.id, ...nothingUnsent })
    const cleared = yield* restarted.GetUnsentMessage({ agentId: agent.id })
    assert.deepStrictEqual({ message: cleared.message, images: cleared.images }, nothingUnsent)
  }),
)

it.live(
  "removes an Agent's worktree and transcript, warning about changes and keeping its branch",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ hang: true })
      const agent = yield* f.start()
      const worktree = f.worktree(agent.name)
      yield* f.model.received(1)

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

      yield* f.model.cancelled(1)
    }),
)

it.live(
  "diffs an Agent's files against its base, uncommitted work included, leaving git alone",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({
        reply: runCommands({
          "Make changes": [
            "printf 'done\\n' > committed.txt && git add committed.txt",
            "git -c user.name=Agent -c user.email=agent@glass.invalid commit --quiet --no-gpg-sign -m Commit",
            "printf 'staged \\n' > staged.txt && git add staged.txt",
            "mkdir 'docs dir' && mv README.md 'docs dir/read é.md'",
            "printf 'hello\\n' > notes.txt && printf '\\000\\001' > logo.bin",
          ].join(" && "),
        }),
      })

      const agent = yield* f.start("Make changes")
      const worktree = f.worktree(agent.name)
      yield* f.transcript(agent.id, settled(1))

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

it.live("lists the models and efforts each agent program offers, with its default", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({})

    const claude = yield* f.client.ListAgentModels({ engine: "claude-code", place: thisMac })
    assert.equal(claude.defaultModel?.name, "Opus 5.5")
    assert.deepStrictEqual(claude.models, [
      { id: "opus", name: "Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "sonnet", name: "Sonnet 5.5", efforts: ["low", "medium", "high"] },
      { id: "claude-haiku-4-5", name: "Haiku 4.5", efforts: [] },
    ])

    const pi = yield* f.client.ListAgentModels({ engine: "pi", place: thisMac })
    assert.equal(pi.defaultModel?.id, "glass-test/gpt-test")
    // pi also lists the models of any other provider this machine has credentials for.
    assert.deepStrictEqual(
      pi.models.filter(({ id }) => id.startsWith("glass-test/")),
      [
        { id: "glass-test/gpt-test", name: "gpt-test", efforts: [] },
        {
          id: "glass-test/gpt-test-thinking",
          name: "GPT Test Thinking",
          efforts: ["off", "minimal", "low", "medium", "high"],
        },
      ],
    )
  }),
)

it.live(
  "lists only the models pi is scoped to, including an extension's, in its order, starting on one of them",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture(
        {},
        {
          enabledModels: ["glass-extension/extension-model", "glass-test/*thinking"],
        },
      )

      yield* Effect.promise(async () => {
        const extensions = join(f.home, ".pi", "agent", "extensions")
        await mkdir(extensions, { recursive: true })
        await writeFile(
          join(extensions, "provider.js"),
          `export default (pi) => pi.registerProvider("glass-extension", {
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test-extension-key",
          api: "openai-completions",
          models: [{
            id: "extension-model",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 4096,
          }],
        })`,
        )
      })

      const pi = yield* f.client.ListAgentModels({ engine: "pi", place: thisMac })
      assert.equal(pi.defaultModel?.id, "glass-extension/extension-model")
      assert.deepStrictEqual(
        pi.models.map(({ id }) => id),
        ["glass-extension/extension-model", "glass-test/gpt-test-thinking"],
      )
    }),
)

it.live(
  "starts a Claude Code Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({}, undefined, { reply: [{ text: "{model} at {effort}" }] })

      const agent = yield* f.start("Which model?", {
        engine: "claude-code",
        model: "sonnet",
        effort: "high",
      })

      const [first] = yield* f.transcript(agent.id, settled(1))
      assert.deepStrictEqual(lastText(first), TextPart.make({ text: "sonnet at high" }))

      const changed = yield* f.client.ChangeAgentModel({
        agentId: agent.id,
        model: null,
        effort: null,
      })

      assert.deepStrictEqual(
        { model: changed.model, effort: changed.effort },
        { model: null, effort: null },
      )

      yield* f.send(agent.id, "And now?")
      const [, second] = yield* f.transcript(agent.id, settled(2))
      assert.deepStrictEqual(lastText(second), TextPart.make({ text: "default at default" }))
    }),
)

it.live(
  "starts a pi Agent on the chosen model and effort, and changes them for the next Turn",
  () =>
    Effect.gen(function* () {
      const f = yield* agentsFixture({ output: "Hi." })

      const agent = yield* f.start("Say hello", {
        engine: "pi",
        model: "glass-test/gpt-test-thinking",
        effort: "high",
      })

      yield* f.transcript(agent.id, settled(1))
      yield* f.client.ChangeAgentModel({ agentId: agent.id, model: null, effort: null })

      const [listed] = yield* f.client
        .WatchAgents()
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      assert.deepStrictEqual(
        { model: listed?.model, effort: listed?.effort },
        { model: null, effort: null },
      )

      yield* f.send(agent.id, "Again")
      yield* f.transcript(agent.id, settled(2))

      assert.deepStrictEqual(
        f.model.calls.map(({ model, reasoning_effort }) => ({ model, reasoning_effort })),
        [
          { model: "gpt-test-thinking", reasoning_effort: "high" },
          { model: "gpt-test", reasoning_effort: undefined },
        ],
      )
    }),
)

it.live("runs a pi Agent's next Turn on pi's own thinking level once its effort is cleared", () =>
  Effect.gen(function* () {
    const f = yield* agentsFixture({ output: "Hi." })
    const thinker = { engine: "pi", model: "glass-test/gpt-test-thinking" } as const

    const agent = yield* f.start("Say hello", { ...thinker, effort: "high" })
    yield* f.transcript(agent.id, settled(1))

    yield* f.client.ChangeAgentModel({ agentId: agent.id, model: thinker.model, effort: null })
    yield* f.send(agent.id, "Again")
    yield* f.transcript(agent.id, settled(2))

    assert.deepStrictEqual(
      f.model.calls.map(({ reasoning_effort }) => reasoning_effort),
      ["high", "medium"],
    )
  }),
)

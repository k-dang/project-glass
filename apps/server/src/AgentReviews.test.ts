import { assert, it } from "@effect/vitest"
import {
  type AgentEngine,
  type AgentReviewState,
  defaultReviewPrompt,
  PullRequestRef,
  Revision,
} from "@glass/contracts"
import { Effect, Exit, Option, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { existsSync } from "node:fs"
import { fakeAgent } from "../test/fakeAgent"
import {
  claudeAnswer,
  type FakeAgentSettings,
  piCliAnswer,
  piCliModels,
} from "../test/fakeAgentFiles"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const answer = {
  markdown: [
    "**The greeting drops callers' punctuation.** The greeting now takes a name.",
    "## Punctuation is dropped\n\nBlocking: `greet` in `greet.ts` strips the name's trailing `!`.",
  ].join("\n\n"),
}

const deadline = 60_000

const fixture = Effect.fnUntraced(function* (
  settings: Partial<FakeAgentSettings> = {},
  timeout = deadline,
  engine: AgentEngine = "pi",
) {
  const piCli = yield* fakeAgent({
    ready: true,
    output: piCliAnswer(JSON.stringify(answer)),
    modelsOutput: piCliModels,
    ...settings,
  })

  const github = yield* startFakeGitHub({ git: true })
  const home = yield* isolatedHome

  const pr = github.seedPullRequest({
    title: "Greet people",
    body: "Use the person's name.",
    base: {
      sha: "b0",
      files: { "greet.ts": "hello\nbye\n", "main.ts": "greet()\n", "old/name.ts": "a\nb\n" },
    },
    head: {
      sha: "h1",
      files: {
        "greet.ts": "hi\nhello name\nbye\n",
        "main.ts": "greet()\n",
        "src/name.ts": "a\nB\n",
      },
    },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        patch: "@@ -1,2 +1,3 @@\n-hello\n+hi\n+hello name\n bye",
      },
      {
        path: "src/name.ts",
        previousPath: "old/name.ts",
        status: "renamed",
        additions: 1,
        deletions: 1,
        patch: "@@ -1,2 +1,2 @@\n a\n-b\n+B",
      },
    ],
  })

  pr.addReviewThread({
    path: "greet.ts",
    line: 2,
    comments: [{ author: "hubot", bodyHtml: "<p>Why a name?</p>" }],
  })
  pr.addDraft({ path: "greet.ts", side: "RIGHT", line: 1, body: "My own note", diffHunk: "" })

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: pr.base.sha, head: pr.head.sha })

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_GIT_REMOTE: github.gitUrl,
    GLASS_PI_COMMAND: piCli.command,
    GLASS_CLAUDE_COMMAND: piCli.command,
    GLASS_AGENT_REVIEW_TIMEOUT_MS: String(timeout),
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  const engineSettings = yield* client.GetEngineSettings({ feature: "agentReviews" })
  yield* client.SetEngineSettings({
    feature: "agentReviews",
    engineSettings: { ...engineSettings, engine },
  })

  const state = (predicate: (state: AgentReviewState) => boolean) =>
    client
      .WatchAgentReview({ pullRequest: ref })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  const failed = state((current) => current.job.status === "failed").pipe(
    Effect.map(({ job }) => (job.status === "failed" ? job.reason : assert.fail(job.status))),
  )

  return {
    piCli,
    github,
    pr,
    ref,
    revision,
    client,
    state,
    failed,
    start: client.StartAgentReview({ pullRequest: ref, revision }),
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      const restarted = yield* startBackend(env, home)

      return yield* restarted.client
        .WatchAgentReview({ pullRequest: ref })
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))
    }),
  }
})

const reviewed = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

it.live(
  "reviews a checkout of the Revision with the PR material and keeps it across restarts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.start
      const { review } = yield* f.state(reviewed)

      const prompted = (yield* f.piCli.calls).find((call) => call.stage === "prompted")!
      assert.deepStrictEqual(prompted.files, ["greet.ts", "main.ts", "src/name.ts"])
      assert.include(prompted.systemPrompt, defaultReviewPrompt)
      assert.include(prompted.input, "Use the person's name.")
      assert.include(prompted.input, "+hello name")
      assert.include(prompted.input, "Why a name?")
      assert.notInclude(prompted.input, "My own note")
      assert.isFalse(existsSync(prompted.cwd))

      assert.deepStrictEqual(review?.revision, f.revision)
      assert.strictEqual(review?.markdown, answer.markdown)

      const activity = yield* f.client.ListActivity({ limit: 10 })
      assert.isEmpty(activity.activities)

      const restored = yield* f.restart
      assert.deepStrictEqual(restored, { review, job: { status: "idle" } })
    }),
)

it.live("reviews with the prompt saved in Settings, leaving the last Agent review as written", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const first = yield* f.state(reviewed)

    const prompt = "Look only at how names are handled."
    assert.strictEqual(yield* f.client.SetReviewPrompt({ prompt }), prompt)
    assert.strictEqual(yield* f.client.GetReviewPrompt(), prompt)
    assert.deepStrictEqual(yield* f.state(reviewed), first)

    yield* f.start
    yield* f.piCli.untilCalls("prompted", 2)
    const prompted = (yield* f.piCli.calls).filter((call) => call.stage === "prompted").at(-1)!
    assert.include(prompted.systemPrompt, prompt)
    assert.notInclude(prompted.systemPrompt, defaultReviewPrompt)
  }),
)

it.live("cancels a running review, removing its checkout, and replaces the last on a rerun", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const first = (yield* f.state(reviewed)).review!

    yield* f.piCli.configure({
      ready: true,
      output: "",
      modelsOutput: piCliModels,
      hangAt: "generate",
    })
    yield* f.start
    yield* f.state((state) => state.job.status === "reviewing" && state.job.runner !== null)
    yield* f.piCli.untilCalls("generate", 2)
    const hung = (yield* f.piCli.calls).filter((call) => call.stage === "generate").at(-1)!
    assert.isTrue(existsSync(hung.cwd))

    yield* f.client.CancelAgentReview({ pullRequest: f.ref })
    const cancelled = yield* f.state((state) => state.job.status === "idle")
    assert.deepStrictEqual(cancelled.review, first)
    assert.throws(() => process.kill(hung.pid, 0))
    assert.isFalse(existsSync(hung.cwd))

    const replacement = { markdown: "**Nothing stands out.**" }
    yield* f.start
    yield* f.piCli.untilCalls("generate", 3)
    yield* f.piCli.configure({
      ready: true,
      output: piCliAnswer(JSON.stringify(replacement)),
      modelsOutput: piCliModels,
    })
    yield* f.start

    const replaced = yield* f.state((state) => reviewed(state) && state.review !== first)
    assert.strictEqual(replaced.review?.markdown, replacement.markdown)
  }),
)

it.live("drops a running review on restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hangAt: "generate" })
    yield* f.start
    yield* f.piCli.untilCalls("generate")

    assert.deepStrictEqual(yield* f.restart, { review: null, job: { status: "idle" } })
  }),
)

it.live("fails as unusable output for an answer that doesn't decode or is empty", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ output: piCliAnswer("not JSON") })
    yield* f.start
    assert.strictEqual((yield* f.failed).reason, "unusable-output")

    yield* f.piCli.configure({
      ready: true,
      output: piCliAnswer(JSON.stringify({ markdown: " \n" })),
      modelsOutput: piCliModels,
    })
    yield* f.start
    yield* f.state((state) => state.job.status === "reviewing")
    assert.strictEqual((yield* f.failed).reason, "unusable-output")
  }),
)

it.live("fails as a stale Revision when the PR has moved on", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.pr.push({ head: { sha: "h2", files: { "greet.ts": "hey\n" } } })
    yield* f.start

    assert.strictEqual((yield* f.failed).reason, "stale-revision")
    assert.isEmpty((yield* f.piCli.calls).filter((call) => call.stage === "prompted"))
  }),
)

it.live(
  "fails as no access when git refuses the Connection, and as a failed fetch when unreachable",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const repository = `${f.pr.owner}/${f.pr.repo}`
      f.github.gitRefusedRepositories.add(repository)
      yield* f.start
      assert.strictEqual((yield* f.failed).reason, "no-access")

      f.github.gitRefusedRepositories.clear()
      f.github.unavailableRepositories.add(repository)
      yield* f.start
      yield* f.state((state) => state.job.status === "reviewing")
      assert.strictEqual((yield* f.failed).reason, "fetch-failed")
    }),
)

it.live("fails as not ready when the pi CLI lacks the saved model", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ modelsOutput: "provider  model" })
    yield* f.start

    assert.strictEqual((yield* f.failed).reason, "not-ready")
  }),
)

it.effect("fails as timed out when the agent passes its limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ hangAt: "generate" })
    yield* f.start
    yield* f.piCli.untilCalls("generate")
    yield* TestClock.adjust(deadline)

    const failure = yield* f.failed
    assert.strictEqual(failure.reason, "timeout")
    assert.strictEqual(failure.runner?.engine, "pi")
  }),
)

it.live("reviews on Claude Code with only its restricted read tools in the checkout", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ output: claudeAnswer(answer) }, 5000, "claude-code")

    yield* f.start
    const done = yield* f.state(reviewed)

    assert.strictEqual(done.review?.markdown, answer.markdown)
    const prompted = (yield* f.piCli.calls).find((call) => call.stage === "prompted")!
    assert.include(prompted.args.join(" "), "--restricted --tools Read,Grep,Glob")
    assert.include(prompted.files ?? [], "greet.ts")
  }),
)

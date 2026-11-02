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
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
import { type ScriptedSettings, scriptedAgentRunners } from "../test/scriptedAgentRunners"

const answer = {
  markdown: [
    "**The greeting drops callers' punctuation.** The greeting now takes a name.",
    "## Punctuation is dropped\n\nBlocking: `greet` in `greet.ts` strips the name's trailing `!`.",
  ].join("\n\n"),
}

const deadline = 60_000

const fixture = Effect.fnUntraced(function* (
  settings: ScriptedSettings = { reply: { answer } },
  engine: AgentEngine = "pi",
) {
  const runners = yield* scriptedAgentRunners(settings)

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
    GLASS_AGENT_REVIEW_TIMEOUT_MS: String(deadline),
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home, runners.layer).pipe(
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
    runners,
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
      const restarted = yield* startBackend(env, home, runners.layer)

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

      const [run] = f.runners.runs
      assert.strictEqual(run?.engine, "pi")
      assert.deepStrictEqual(run?.files, ["greet.ts", "main.ts", "src/name.ts"])
      assert.include(run?.task.instructions, defaultReviewPrompt)
      assert.include(run?.task.prompt, "Use the person's name.")
      assert.include(run?.task.prompt, "+hello name")
      assert.include(run?.task.prompt, "Why a name?")
      assert.notInclude(run?.task.prompt, "My own note")
      assert.isFalse(existsSync(run!.directory!))

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
    yield* f.runners.ran(2)
    const instructions = f.runners.runs.at(-1)!.task.instructions
    assert.include(instructions, prompt)
    assert.notInclude(instructions, defaultReviewPrompt)
  }),
)

it.live("cancels a running review, removing its checkout, and replaces the last on a rerun", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.start
    const first = (yield* f.state(reviewed)).review!

    yield* f.runners.configure({ reply: "hold" })
    yield* f.start
    yield* f.state((state) => state.job.status === "reviewing" && state.job.runner !== null)
    yield* f.runners.ran(2)
    const checkout = f.runners.runs.at(-1)!.directory!
    assert.isTrue(existsSync(checkout))

    yield* f.client.CancelAgentReview({ pullRequest: f.ref })
    const cancelled = yield* f.state((state) => state.job.status === "idle")
    assert.deepStrictEqual(cancelled.review, first)
    yield* f.runners.interrupted(1)
    assert.isFalse(existsSync(checkout))

    const replacement = { markdown: "**Nothing stands out.**" }
    yield* f.start
    yield* f.runners.ran(3)
    yield* f.runners.configure({ reply: { answer: replacement } })
    yield* f.start

    const replaced = yield* f.state((state) => reviewed(state) && state.review !== first)
    assert.strictEqual(replaced.review?.markdown, replacement.markdown)
  }),
)

it.live("drops a running review on restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: "hold" })
    yield* f.start
    yield* f.runners.ran(1)

    assert.deepStrictEqual(yield* f.restart, { review: null, job: { status: "idle" } })
  }),
)

it.live("fails as unusable output for an empty review", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: { answer: { markdown: " \n" } } })
    yield* f.start

    assert.strictEqual((yield* f.failed).reason, "unusable-output")
  }),
)

it.live("fails as a stale Revision when the PR has moved on", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.pr.push({ head: { sha: "h2", files: { "greet.ts": "hey\n" } } })
    yield* f.start

    assert.strictEqual((yield* f.failed).reason, "stale-revision")
    assert.isEmpty(f.runners.runs)
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

for (const ready of ["not-ready", "not-installed"] as const)
  it.live(`fails as not ready when the runner is ${ready}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture({ reply: { answer }, ready })
      yield* f.start

      assert.strictEqual((yield* f.failed).reason, "not-ready")
    }),
  )

it.effect("fails as timed out when the agent passes its limit", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: "hold" })
    yield* f.start
    yield* f.runners.ran(1)
    yield* TestClock.adjust(deadline)

    const failure = yield* f.failed
    assert.strictEqual(failure.reason, "timeout")
    assert.strictEqual(failure.runner?.engine, "pi")
  }),
)

it.live("reviews on the engine chosen for Agent reviews", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: { answer } }, "claude-code")
    yield* f.start
    yield* f.state(reviewed)

    assert.deepStrictEqual(f.runners.selections, ["claude-code"])
  }),
)

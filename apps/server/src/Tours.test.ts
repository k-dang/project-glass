import { assert, it } from "@effect/vitest"
import { type AgentEngine, PullRequestRef, Revision, type TourState } from "@glass/contracts"
import { Effect, Exit, Fiber, Option, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { startFakeGitHub } from "../test/fakeGitHub"
import { VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
import { type ScriptedSettings, scriptedAgentRunners } from "../test/scriptedAgentRunners"
import { tourInstructions } from "./tourPrompt"

const answer = {
  intent: "Greet people by name.",
  chapters: [
    {
      title: "Name the greeting",
      explanation: "Use the supplied name.",
      files: [{ path: "greet.ts", summary: "Builds the greeting." }],
    },
  ],
  unplacedFiles: [],
}

const deadline = 60_000

const fixture = Effect.fnUntraced(function* (settings: ScriptedSettings = { reply: { answer } }) {
  const runners = yield* scriptedAgentRunners(settings)
  const github = yield* startFakeGitHub()
  const home = yield* isolatedHome

  const pr = github.seedPullRequest({
    title: "Greet people",
    body: "Use the person's name.",
    base: { sha: "b0", files: { "greet.ts": "hello" } },
    head: {
      sha: "h1",
      files: { "greet.ts": "hello name", "README.md": "greeting", "logo.png": "\0binary" },
    },
    changedFiles: [
      {
        path: "greet.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        patch: "@@ -1 +1 @@\n-hello\n+hello name",
      },
      { path: "README.md", status: "added" },
      { path: "logo.png", status: "added" },
    ],
  })

  const ref = new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })
  const revision = new Revision({ base: "b0", head: "h1" })

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_TOUR_TIMEOUT_MS: String(deadline),
  }

  const serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home, runners.layer).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  const state = (predicate: (state: TourState) => boolean) =>
    client
      .WatchTour({ pullRequest: ref })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  return {
    runners,
    github,
    pr,
    ref,
    revision,
    client,
    state,
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      const restarted = yield* startBackend(env, home, runners.layer)

      return yield* restarted.client
        .WatchTour({ pullRequest: ref })
        .pipe(Stream.runHead, Effect.map(Option.getOrThrow))
    }),
    write: client.WriteTour({ pullRequest: ref, revision }),
    useEngine: (engine: AgentEngine) =>
      client
        .GetEngineSettings({ feature: "tours" })
        .pipe(
          Effect.flatMap((current) =>
            client.SetEngineSettings({ feature: "tours", engineSettings: { ...current, engine } }),
          ),
        ),
  }
})

const completed = (state: TourState) => state.job.status !== "writing"

it.live("writes a saved Tour from the requested Revision's PR material, without file access", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    assert.deepStrictEqual(yield* f.state(() => true), { tour: null, job: { status: "idle" } })

    yield* f.write
    const state = yield* f.state((current) => current.tour !== null)

    assert.equal(state.tour?.intent, answer.intent)
    assert.deepStrictEqual(state.tour?.chapters, answer.chapters)
    assert.deepStrictEqual(state.tour?.revision, f.revision)
    assert.equal(state.job.status, "idle")
    const [run] = f.runners.runs
    assert.strictEqual(run?.task.instructions, tourInstructions)
    assert.strictEqual(run?.task.files, "none")
    assert.include(run?.task.prompt, "Greet people")
    assert.include(run?.task.prompt, "Use the person's name.")
    assert.include(run?.task.prompt, "+hello name")
  }),
)

it.live(
  "cancels a running Tour and keeps the saved one after a failed replacement and restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write
      const saved = yield* f.state((state) => state.tour !== null)
      yield* f.runners.configure({ reply: "hold" })
      yield* f.write
      yield* f.state((state) => state.job.status === "writing" && state.job.runner !== null)
      yield* f.runners.ran(2)

      yield* f.client.CancelTour({ pullRequest: f.ref })
      assert.deepStrictEqual((yield* f.state(completed)).tour, saved.tour)
      yield* f.runners.interrupted(1)

      yield* f.runners.configure({ reply: { fail: "unusable-output" } })
      yield* f.write
      const failed = yield* f.state(completed)
      assert.deepStrictEqual(failed.tour, saved.tour)
      assert.equal(failed.job.status, "failed")

      assert.deepStrictEqual(yield* f.restart, { tour: saved.tour, job: { status: "idle" } })
    }),
)

it.live(
  "repairs invented, duplicate, omitted, and unplaced paths without rejecting coverage mistakes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({
        reply: {
          answer: {
            intent: "Cover every file.",
            chapters: [
              {
                title: "Greeting",
                explanation: "Changes behavior.",
                files: [
                  { path: "greet.ts", summary: "First placement." },
                  { path: "invented.ts", summary: "Drop this." },
                ],
              },
              {
                title: "Duplicate",
                explanation: "",
                files: [{ path: "greet.ts", summary: "Drop duplicate." }],
              },
              { title: "Context", explanation: "Keep this explanation.", files: [] },
            ],
            unplacedFiles: ["logo.png", "logo.png", "invented.ts", "greet.ts"],
          },
        },
      })

      yield* f.write
      const state = yield* f.state(completed)
      assert.deepStrictEqual(
        state.tour?.chapters.map((chapter) => [
          chapter.title,
          chapter.files.map((file) => file.path),
        ]),
        [
          ["Greeting", ["greet.ts"]],
          ["Context", []],
        ],
      )
      assert.deepStrictEqual(state.tour?.everythingElse, ["logo.png", "README.md"])
      assert.include(f.runners.runs[0]?.task.prompt, "logo.png")
    }),
)

for (const [name, settings, expected] of [
  ["an invalid answer", { reply: { answer: { chapters: "wrong" } } }, "unusable-output"],
  ["no surviving Chapters", { reply: { answer: { ...answer, chapters: [] } } }, "unusable-output"],
  ["a runner failure", { reply: { fail: "failed" } }, "runner"],
  ["an authentication rejection", { reply: { fail: "authentication" } }, "authentication"],
  ["a runner that isn't ready", { reply: { answer }, ready: "not-ready" }, "not-ready"],
  ["a runner that isn't installed", { reply: { answer }, ready: "not-installed" }, "not-installed"],
] as const satisfies ReadonlyArray<readonly [string, ScriptedSettings, string]>) {
  it.live(`reports ${name}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(settings)
      yield* f.write

      const state = yield* f.state(completed)
      assert.equal(state.job.status === "failed" && state.job.reason.reason, expected)
      assert.isNull(state.tour)
    }),
  )
}

for (const [name, settings, started] of [
  ["slow generation", { reply: "hold" }, "ran"],
  ["a slow readiness check", { reply: { answer }, ready: "hang" }, "selected"],
] as const) {
  it.effect(`times out ${name}`, () =>
    Effect.gen(function* () {
      const f = yield* fixture(settings)
      yield* f.write
      yield* f.runners[started](1)
      yield* TestClock.adjust(deadline)

      const state = yield* f.state(completed)
      assert.equal(state.job.status === "failed" && state.job.reason.reason, "timeout")
      assert.isNull(state.tour)
    }),
  )
}

it.live("retries a runner that wasn't installed once it is", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: { answer }, ready: "not-installed" })
    yield* f.write
    const missing = yield* f.state(completed)
    assert.equal(missing.job.status === "failed" && missing.job.reason.reason, "not-installed")

    yield* f.runners.configure({ reply: { answer } })
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)
  }),
)

it.live("rejects a Revision that changes during the GitHub file read", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    f.github.beforeNext(`/repos/${f.pr.owner}/${f.pr.repo}/pulls/`, () =>
      f.pr.push({ head: { sha: "h2", files: { "greet.ts": "new" } } }),
    )
    yield* f.write
    const state = yield* f.state(completed)
    assert.equal(state.job.status === "failed" && state.job.reason.reason, "github")
    assert.isEmpty(f.runners.runs)
    assert.isNull(state.tour)
  }),
)

it.live(
  "keeps jobs after subscribers leave and replaces a running job without publishing its result",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ reply: "hold" })

      const observer = yield* f.client
        .WatchTour({ pullRequest: f.ref })
        .pipe(Stream.runDrain, Effect.forkChild)

      yield* f.write
      yield* f.runners.ran(1)
      yield* Fiber.interrupt(observer)

      const second = f.github.seedPullRequest({
        base: { sha: "b0", files: {} },
        head: { sha: "h1", files: { "greet.ts": "hi" } },
        changedFiles: [{ path: "greet.ts", status: "added" }],
      })

      const other = new PullRequestRef({
        owner: second.owner,
        repo: second.repo,
        number: second.number,
      })

      yield* f.client.WriteTour({ pullRequest: other, revision: f.revision })
      yield* f.runners.ran(2)
      yield* f.runners.configure({ reply: { answer: { ...answer, intent: "Replacement wins." } } })
      yield* f.write
      yield* f.runners.interrupted(1)
      assert.equal((yield* f.state(completed)).tour?.intent, "Replacement wins.")
      yield* f.runners.release({ answer })

      const otherSaved = yield* f.client
        .WatchTour({ pullRequest: other })
        .pipe(Stream.filter(completed), Stream.runHead, Effect.map(Option.getOrThrow))

      assert.equal(otherSaved.tour?.intent, answer.intent)
      assert.equal((yield* f.state(completed)).tour?.intent, "Replacement wins.")
    }),
)

it.live("uses the selected runner and never falls back after failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.useEngine("pi")
    yield* f.write
    assert.equal((yield* f.state(completed)).tour?.intent, answer.intent)

    yield* f.runners.configure({ reply: { answer }, ready: "not-ready" })
    yield* f.useEngine("claude-code")
    yield* f.write
    const rejected = yield* f.state(completed)
    assert.equal(rejected.job.status === "failed" && rejected.job.reason.reason, "not-ready")

    yield* f.runners.configure({ reply: { fail: "unusable-output" } })
    yield* f.useEngine("pi")
    yield* f.write
    const invalid = yield* f.state(completed)
    assert.equal(invalid.job.status === "failed" && invalid.job.reason.reason, "unusable-output")

    assert.deepStrictEqual(f.runners.selections, ["pi", "claude-code", "pi"])
    assert.deepStrictEqual(
      f.runners.runs.map((run) => run.engine),
      ["pi", "pi"],
    )
  }),
)

it.live("cancels a readiness check and loses only the running job on a backend restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ reply: { answer }, ready: "hang" })
    yield* f.write
    yield* f.runners.selected(1)
    yield* f.client.CancelTour({ pullRequest: f.ref })
    assert.deepStrictEqual(yield* f.state(completed), { tour: null, job: { status: "idle" } })
    yield* f.runners.interrupted(1)

    yield* f.runners.configure({ reply: "hold" })
    yield* f.write
    yield* f.state((state) => state.job.status === "writing" && state.job.runner !== null)

    assert.deepStrictEqual(yield* f.restart, { tour: null, job: { status: "idle" } })
  }),
)

it.live(
  "rewrites a Tour for a newer Revision, streaming the old Tour until the replacement is saved",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.write
      const saved = (yield* f.state((state) => state.tour !== null)).tour!
      f.pr.push({
        head: { sha: "h2", files: { "greet.ts": "hello there", "new.ts": "new" } },
        changedFiles: [
          {
            path: "greet.ts",
            status: "modified",
            additions: 1,
            deletions: 1,
            patch: "@@ -1 +1 @@\n-hello\n+hello there",
          },
          { path: "new.ts", status: "added" },
        ],
      })
      yield* f.runners.configure({ reply: "hold" })

      const states = yield* f.client.WatchTour({ pullRequest: f.ref }).pipe(
        Stream.takeUntil((state) => state.tour?.intent === "Rewritten."),
        Stream.runCollect,
        Effect.forkChild,
      )

      const requested = new Revision({ base: "b0", head: "h2" })
      yield* f.client.WriteTour({ pullRequest: f.ref, revision: requested })
      yield* f.runners.ran(2)
      f.pr.push({ head: { sha: "h3", files: { "greet.ts": "later" } } })
      yield* f.runners.release({
        answer: {
          ...answer,
          intent: "Rewritten.",
          chapters: [
            { ...answer.chapters[0]!, files: [{ path: "new.ts", summary: "Adds a file." }] },
          ],
        },
      })
      const streamed = yield* Fiber.join(states)
      const rewritten = streamed.at(-1)!

      for (const state of streamed.slice(0, -1)) assert.deepStrictEqual(state.tour, saved)
      assert.isTrue(
        streamed.some((state) => state.job.status === "writing" && state.job.runner === null),
      )
      assert.isTrue(
        streamed.some((state) => state.job.status === "writing" && state.job.runner !== null),
      )
      assert.deepStrictEqual(rewritten.job, { status: "idle" })
      assert.deepStrictEqual(rewritten.tour?.revision, requested)
      assert.isAbove(rewritten.tour!.writtenAt.epochMilliseconds, saved.writtenAt.epochMilliseconds)

      assert.deepStrictEqual(yield* f.restart, { tour: rewritten.tour, job: { status: "idle" } })
    }),
)

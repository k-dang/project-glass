import { assert, it } from "@effect/vitest"
import { PullRequestRef, type TourState } from "@glass/contracts"
import { Effect, Exit, Option, Scope, Stream } from "effect"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fakeAgent } from "../test/fakeAgent"
import { claudeAnswer } from "../test/fakeAgentFiles"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, type FakePullRequestState, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"

const answer = claudeAnswer({
  intent: "Greet people by name.",
  chapters: [
    {
      title: "Name the greeting",
      explanation: "Use the supplied name.",
      files: [{ path: "greet.ts", summary: "Builds the greeting." }],
    },
  ],
  unplacedFiles: [],
})

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

type Client = Effect.Success<ReturnType<typeof startBackend>>["client"]

const tourState = (
  client: Client,
  pr: FakePullRequest,
  predicate: (state: TourState) => boolean = () => true,
) =>
  client
    .WatchTour({ pullRequest: ref(pr) })
    .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

const fixture = Effect.fnUntraced(function* ({ timeoutMs = 60_000, queueTours = true } = {}) {
  const home = yield* isolatedHome
  const gate = join(home, "answer")
  const agent = yield* fakeAgent({ ready: true, output: answer, gate })
  const github = yield* startFakeGitHub()

  const seed = (title: string, state: FakePullRequestState = "OPEN") =>
    github.seedPullRequest({
      title,
      state,
      base: { sha: "b0", files: { "greet.ts": "hello" } },
      head: { sha: `h-${title}`, files: { "greet.ts": "hello name" } },
      changedFiles: [
        {
          path: "greet.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          patch: "@@ -1 +1 @@\n-hello\n+hello name",
        },
      ],
    })

  const env = {
    GH_TOKEN: VIEWER.token,
    GLASS_GITHUB_API_URL: github.url,
    GLASS_CLAUDE_COMMAND: agent.command,
    GLASS_TOUR_TIMEOUT_MS: String(timeoutMs),
  }

  let serverScope = yield* Scope.make()
  yield* Effect.addFinalizer((exit) => Scope.close(serverScope, exit))

  const { client } = yield* startBackend(env, home).pipe(
    Effect.provideService(Scope.Scope, serverScope),
  )

  if (queueTours) yield* client.SetQueueTours({ enabled: true })

  return {
    agent,
    seed,
    client,
    untilPrompted: (count: number) => agent.untilCalls("prompted", count),
    prompted: agent.calls.pipe(
      Effect.map((calls) => calls.filter(({ stage }) => stage === "prompted")),
    ),
    answer: Effect.promise(() => writeFile(gate, "")),
    restart: Effect.gen(function* () {
      yield* Scope.close(serverScope, Exit.void)
      serverScope = yield* Scope.make()

      return (yield* startBackend(env, home).pipe(Effect.provideService(Scope.Scope, serverScope)))
        .client
    }),
  }
})

const hasTour = (state: TourState) => state.tour !== null

const idle: TourState = { tour: null, job: { status: "idle" } }

it.live(
  "writes no Tour for the Queue until Tours are turned on, then only for PRs added after",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture({ queueTours: false })
      yield* f.answer
      const before = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(before)] })

      assert.isFalse(yield* f.client.GetQueueTours())
      assert.deepStrictEqual(yield* tourState(f.client, before), idle)

      yield* f.client.SetQueueTours({ enabled: true })
      const after = f.seed("Wave")
      yield* f.client.AddToQueue({ references: [ref(after)] })

      assert.isNotNull((yield* tourState(f.client, after, hasTour)).tour)
      assert.deepStrictEqual(yield* tourState(f.client, before), idle)
      assert.lengthOf(yield* f.prompted, 1)
    }),
)

it.live("turning Tours off cancels the Queue's Tours but not one the user started", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const queued = ["Greet", "Wave", "Fibers"].map((title) => f.seed(title))
    const opened = f.seed("Opened")
    yield* f.client.AddToQueue({ references: queued.map(ref) })
    yield* f.client.WriteTour({
      pullRequest: ref(opened),
      revision: (yield* f.client.OpenPullRequest({ pullRequest: ref(opened) })).revision,
    })
    yield* f.untilPrompted(3)

    yield* f.client.SetQueueTours({ enabled: false })

    for (const pr of queued) assert.deepStrictEqual(yield* tourState(f.client, pr), idle)

    yield* f.answer
    assert.isNotNull((yield* tourState(f.client, opened, hasTour)).tour)
    assert.lengthOf(yield* f.prompted, 3)
  }),
)

it.live("writes a Tour for every PR added to the Queue, two at a time", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const prs = ["Greet", "Wave", "Fibers"].map((title) => f.seed(title))
    yield* f.client.AddToQueue({ references: prs.map(ref) })
    yield* f.untilPrompted(2)

    const states = yield* Effect.forEach(prs, (pr) => tourState(f.client, pr))
    assert.deepStrictEqual(
      states.map(({ job }) => job.status),
      ["writing", "writing", "waiting"],
    )
    assert.lengthOf(yield* f.prompted, 2)

    yield* f.answer
    const saved = yield* Effect.forEach(prs, (pr) => tourState(f.client, pr, hasTour))

    assert.deepStrictEqual(
      saved.map(({ tour }) => tour?.revision.head),
      prs.map((pr) => pr.head.sha),
    )
    assert.lengthOf(yield* f.prompted, 3)
  }),
)

it.live("starts a waiting Tour's timeout only once a slot is free", () =>
  Effect.gen(function* () {
    const f = yield* fixture({ timeoutMs: 1500 })
    const prs = ["Greet", "Wave", "Fibers"].map((title) => f.seed(title))
    yield* f.client.AddToQueue({ references: prs.map(ref) })

    const failed = yield* Effect.forEach(
      prs,
      (pr) => tourState(f.client, pr, (state) => state.job.status === "failed"),
      { concurrency: "unbounded" },
    )

    assert.deepStrictEqual(
      failed.map(({ job }) => (job.status === "failed" ? job.reason.reason : job.status)),
      ["timeout", "timeout", "timeout"],
    )

    const lastQueued = prs.at(-1)!
    assert.isTrue((yield* f.prompted).some(({ input }) => input?.includes(lastQueued.title)))
  }),
)

it.live("cancels the Tour of a PR leaving the Queue and starts the next one waiting", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    const [removed, reviewed, next] = ["Greet", "Wave", "Fibers"].map((title) => f.seed(title))
    yield* f.client.AddToQueue({ references: [ref(removed!), ref(reviewed!), ref(next!)] })
    yield* f.untilPrompted(2)
    const runner = (yield* f.prompted).find(({ input }) => input?.includes(removed!.title))

    yield* f.client.RemoveFromQueue({ reference: ref(removed!) })
    assert.deepStrictEqual(yield* tourState(f.client, removed!), idle)
    assert.throws(() => process.kill(runner!.pid, 0))
    yield* f.untilPrompted(3)

    const opened = yield* f.client.OpenPullRequest({ pullRequest: ref(reviewed!) })
    yield* f.client.SubmitReview({
      pullRequestId: opened.pullRequest.id,
      revision: opened.revision,
      decision: "approve",
      summary: "",
    })
    assert.deepStrictEqual(yield* tourState(f.client, reviewed!), idle)

    yield* f.answer
    assert.isNotNull((yield* tourState(f.client, next!, hasTour)).tour)
  }),
)

it.live(
  "leaves an outdated Tour alone and, after a restart, writes only for newly queued PRs",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.answer
      const written = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(written)] })
      const before = yield* tourState(f.client, written, hasTour)

      written.push({ head: { sha: "h-pushed", files: { "greet.ts": "hello again" } } })
      yield* f.client.RefreshQueue()
      assert.strictEqual((yield* f.client.ListSavedQueue())[0]?.revision?.head, "h-pushed")

      yield* f.agent.configure({ ready: true, output: answer, hangAt: "generate" })
      const interrupted = f.seed("Wave")
      yield* f.client.AddToQueue({ references: [ref(interrupted)] })
      yield* tourState(f.client, interrupted, (state) => state.job.status === "writing")

      yield* f.agent.configure({ ready: true, output: answer })
      const client = yield* f.restart
      const added = f.seed("Fibers")
      yield* client.AddToQueue({ references: [ref(added)] })

      assert.isNotNull((yield* tourState(client, added, hasTour)).tour)
      assert.deepStrictEqual(yield* tourState(client, interrupted), idle)
      assert.deepStrictEqual(yield* tourState(client, written), before)
    }),
)

it.live("writes no Tour for a merged or closed PR", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.answer
    const finished = [f.seed("Merged", "MERGED"), f.seed("Closed", "CLOSED")]
    const open = f.seed("Open")
    yield* f.client.AddToQueue({ references: [...finished, open].map(ref) })
    yield* tourState(f.client, open, hasTour)

    for (const pr of finished) assert.deepStrictEqual(yield* tourState(f.client, pr), idle)
    assert.lengthOf(yield* f.prompted, 1)
  }),
)

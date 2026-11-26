import { assert, it } from "@effect/vitest"
import {
  type AgentReviewState,
  applyTranscriptUpdate,
  emptyTranscript,
  PullRequestRef,
  Revision,
  type TourState,
} from "@glass/contracts"
import { Effect, Option, Stream } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { vi } from "vite-plus/test"
import { eventually } from "../test/eventually"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
import { scriptedAgentRunners } from "../test/scriptedAgentRunners"
import { scriptedReviews } from "../test/scriptedReviews"
import { scriptedHost } from "../test/threadsFixture"

const answer = {
  markdown: "**Nothing stands out.** The greeting now takes a name.",
  hotspots: [],
  lowAttention: [],
}

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const fixture = Effect.fnUntraced(function* () {
  const home = yield* isolatedHome
  const gates = join(home, "gates")
  mkdirSync(gates)
  vi.stubEnv("GLASS_SCRIPTED_GATES", gates)
  const reviews = scriptedReviews(gates)
  yield* reviews.hold
  const runners = yield* scriptedAgentRunners({ reply: "hold" })
  const github = yield* startFakeGitHub({ git: true })

  const seed = (title: string) =>
    github.seedPullRequest({
      title,
      base: { sha: "b0", files: { "greet.ts": "hello\n" } },
      head: { sha: `h-${title}`, files: { "greet.ts": "hello name\n" } },
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

  const { client } = yield* startBackend(
    {
      GH_TOKEN: VIEWER.token,
      GLASS_GITHUB_API_URL: github.url,
      GLASS_GIT_REMOTE: github.gitUrl,
      GLASS_AGENT_HOST_BUNDLE: scriptedHost,
    },
    home,
    runners.layer,
  )

  const reviewState = (pr: FakePullRequest, predicate: (state: AgentReviewState) => boolean) =>
    client
      .WatchAgentReview({ pullRequest: ref(pr) })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  const tourState = (pr: FakePullRequest, predicate: (state: TourState) => boolean) =>
    client
      .WatchTour({ pullRequest: ref(pr) })
      .pipe(Stream.filter(predicate), Stream.runHead, Effect.map(Option.getOrThrow))

  const reviewed = (prs: ReadonlyArray<FakePullRequest>) =>
    eventually(
      client.WatchThreads().pipe(
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.flatMap((threads) => {
          const names = threads.flatMap(({ forReview, name }) => (forReview ? [name] : []))
          const wanted = prs.map((pr) => `Agent review of ${pr.owner}/${pr.repo}#${pr.number}`)

          return names.toSorted().join() === wanted.toSorted().join()
            ? Effect.succeed(threads)
            : Effect.fail(names)
        }),
      ),
    )

  return { reviews, runners, client, seed, reviewState, tourState, reviewed }
})

const status = (wanted: AgentReviewState["job"]["status"]) => (state: AgentReviewState) =>
  state.job.status === wanted

const done = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

it.live(
  "runs no Agent review for the Queue until turned on, then two at a time for PRs added after",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const before = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(before)] })
      assert.isFalse(yield* f.client.GetQueueWork({ feature: "agentReviews" }))

      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
      const added = ["Wave", "Fibers", "Layers"].map((title) => f.seed(title))
      yield* f.client.AddToQueue({ references: added.map(ref) })

      yield* f.reviewed(added.slice(0, 2))
      const states = yield* Effect.forEach(added, (pr) => f.reviewState(pr, () => true))
      assert.deepStrictEqual(
        states.map(({ job }) => job.status),
        ["reviewing", "reviewing", "waiting"],
      )

      yield* f.reviews.release({ submit: [answer] })
      yield* Effect.forEach(added, (pr) => f.reviewState(pr, done))
      yield* f.reviewState(before, status("idle"))
      assert.isEmpty(f.runners.runs)
    }),
)

it.live(
  "turning Agent reviews off cancels the Queue's reviews but not Tours or one the user started",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      yield* f.client.SetQueueWork({ feature: "tours", enabled: true })
      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
      const opened = f.seed("Opened")
      const [running, alsoRunning, waiting] = [f.seed("Greet"), f.seed("Wave"), f.seed("Fibers")]
      yield* f.client.StartAgentReview({
        pullRequest: ref(opened),
        revision: new Revision({ base: opened.base.sha, head: opened.head.sha }),
      })
      yield* f.client.AddToQueue({ references: [ref(running), ref(alsoRunning), ref(waiting)] })
      yield* f.reviewed([opened, running, alsoRunning])
      yield* f.reviewState(waiting, status("waiting"))

      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: false })

      yield* f.reviewState(running, status("idle"))
      yield* f.reviewState(alsoRunning, status("idle"))
      yield* f.reviewState(waiting, status("idle"))
      yield* f.reviewState(opened, status("reviewing"))
      yield* f.reviewed([opened])
      yield* f.tourState(running, (state) => state.job.status === "writing")
      assert.isTrue(yield* f.client.GetQueueWork({ feature: "tours" }))
    }),
)

it.live("cancels the Agent review of a PR leaving the Queue and starts the next one waiting", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
    const [removed, running, next] = [f.seed("Greet"), f.seed("Wave"), f.seed("Fibers")]
    yield* f.client.AddToQueue({ references: [ref(removed), ref(running), ref(next)] })
    yield* f.reviewed([removed, running])

    yield* f.client.RemoveFromQueue({ reference: ref(removed) })

    yield* f.reviewState(removed, status("idle"))
    const threads = yield* f.reviewed([running, next])
    const started = threads.find(({ name }) => name.endsWith(`#${next.number}`))!

    const [first] = yield* f.client.WatchTranscript({ threadId: started.id }).pipe(
      Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
      Stream.map(({ turns }) => turns),
      Stream.filter((turns) => turns.length > 0),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    )

    assert.include(first?.message, next.title)
  }),
)

it.live("runs no Agent review for a queued PR that already has one", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.reviews.script({ submit: [answer] })
    const pr = f.seed("Greet")
    yield* f.client.StartAgentReview({
      pullRequest: ref(pr),
      revision: new Revision({ base: pr.base.sha, head: pr.head.sha }),
    })
    const before = yield* f.reviewState(pr, done)

    yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
    yield* f.client.AddToQueue({ references: [ref(pr)] })

    assert.deepStrictEqual(yield* f.reviewState(pr, () => true), before)
    yield* f.reviewed([pr])
  }),
)

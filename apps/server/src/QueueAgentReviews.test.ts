import { assert, it } from "@effect/vitest"
import { type AgentReviewState, PullRequestRef, Revision, type TourState } from "@glass/contracts"
import { Effect, Option, Stream } from "effect"
import { startFakeGitHub } from "../test/fakeGitHub"
import { type FakePullRequest, VIEWER } from "../test/fakePullRequest"
import { isolatedHome, startBackend } from "../test/harness"
import { scriptedAgentRunners } from "../test/scriptedAgentRunners"

const answer = { markdown: "**Nothing stands out.** The greeting now takes a name." }

const ref = (pr: FakePullRequest) =>
  new PullRequestRef({ owner: pr.owner, repo: pr.repo, number: pr.number })

const fixture = Effect.fnUntraced(function* () {
  const home = yield* isolatedHome
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
      GLASS_AGENT_REVIEW_TIMEOUT_MS: "60000",
      GLASS_TOUR_TIMEOUT_MS: "60000",
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

  const subjects = () => runners.runs.map(({ task }) => task.subject)

  return { runners, client, seed, reviewState, tourState, subjects }
})

const status = (wanted: AgentReviewState["job"]["status"]) => (state: AgentReviewState) =>
  state.job.status === wanted

const reviewed = (state: AgentReviewState) => state.review !== null && state.job.status === "idle"

it.live(
  "runs no Agent review for the Queue until turned on, then one at a time for PRs added after",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const before = f.seed("Greet")
      yield* f.client.AddToQueue({ references: [ref(before)] })
      assert.isFalse(yield* f.client.GetQueueWork({ feature: "agentReviews" }))

      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
      const [first, second] = [f.seed("Wave"), f.seed("Fibers")]
      yield* f.client.AddToQueue({ references: [ref(first), ref(second)] })

      yield* f.runners.ran(1)
      yield* f.reviewState(first, status("reviewing"))
      yield* f.reviewState(second, status("waiting"))

      yield* f.runners.release({ answer })
      yield* f.reviewState(first, reviewed)
      yield* f.reviewState(second, reviewed)
      yield* f.reviewState(before, status("idle"))
      assert.deepStrictEqual(f.subjects(), ["Agent review", "Agent review"])
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
      const [running, waiting] = [f.seed("Greet"), f.seed("Wave")]
      yield* f.client.StartAgentReview({
        pullRequest: ref(opened),
        revision: new Revision({ base: opened.base.sha, head: opened.head.sha }),
      })
      yield* f.client.AddToQueue({ references: [ref(running), ref(waiting)] })
      yield* f.reviewState(running, status("reviewing"))
      yield* f.reviewState(waiting, status("waiting"))

      yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: false })

      yield* f.reviewState(running, status("idle"))
      yield* f.reviewState(waiting, status("idle"))
      yield* f.reviewState(opened, status("reviewing"))
      yield* f.tourState(running, (state) => state.job.status === "writing")
      assert.isTrue(yield* f.client.GetQueueWork({ feature: "tours" }))
    }),
)

it.live("cancels the Agent review of a PR leaving the Queue and starts the next one waiting", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
    const [removed, next] = [f.seed("Greet"), f.seed("Wave")]
    yield* f.client.AddToQueue({ references: [ref(removed), ref(next)] })
    yield* f.runners.ran(1)

    yield* f.client.RemoveFromQueue({ reference: ref(removed) })

    yield* f.reviewState(removed, status("idle"))
    yield* f.runners.interrupted(1)
    yield* f.runners.ran(2)
    assert.include(f.runners.runs.at(-1)?.task.prompt, next.title)
  }),
)

it.live("runs no Agent review for a queued PR that already has one", () =>
  Effect.gen(function* () {
    const f = yield* fixture()
    yield* f.runners.configure({ reply: { answer } })
    const pr = f.seed("Greet")
    yield* f.client.StartAgentReview({
      pullRequest: ref(pr),
      revision: new Revision({ base: pr.base.sha, head: pr.head.sha }),
    })
    const before = yield* f.reviewState(pr, reviewed)

    yield* f.client.SetQueueWork({ feature: "agentReviews", enabled: true })
    yield* f.client.AddToQueue({ references: [ref(pr)] })

    assert.deepStrictEqual(yield* f.reviewState(pr, () => true), before)
    assert.lengthOf(f.runners.runs, 1)
  }),
)

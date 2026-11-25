import { defaultSubscriptionReasons, type SubscriptionReason, type Turn } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import type { FakeCheck, FakePullRequest } from "./fakePullRequest"
import { glassCall, settled, type threadsFixture } from "./threadsFixture"
import { threadWithPullRequest } from "./threadWithPullRequest"

type Fixture = Effect.Success<typeof threadsFixture>

export const subscribe = (
  note: string,
  reasons: ReadonlyArray<SubscriptionReason> = defaultSubscriptionReasons,
  pullRequest?: FakePullRequest,
) =>
  glassCall(
    "subscribe_to_pull_request",
    pullRequest === undefined
      ? { note, reasons }
      : {
          note,
          reasons,
          pullRequest: {
            owner: pullRequest.owner,
            repo: pullRequest.repo,
            number: pullRequest.number,
          },
        },
  )

export const subscribedThread = (
  note = "Keep it green",
  reasons?: ReadonlyArray<SubscriptionReason>,
) =>
  Effect.gen(function* () {
    const f = yield* threadWithPullRequest
    yield* f.send(f.thread.id, subscribe(note, reasons))
    yield* f.transcript(f.thread.id, settled(2))

    return f
  })

export const failed = (name: string, run = 1): FakeCheck => ({
  kind: "CheckRun",
  name,
  conclusion: "FAILURE",
  url: `https://ci.test/${name}/${run}`,
})

export const running = (name: string): FakeCheck => ({
  kind: "CheckRun",
  name,
  status: "IN_PROGRESS",
})

export const fail = (pullRequest: FakePullRequest, ...checks: ReadonlyArray<FakeCheck>) => {
  pullRequest.checks = "FAILURE"
  pullRequest.checkContexts = checks
}

export const pass = (pullRequest: FakePullRequest) => {
  pullRequest.checks = "SUCCESS"
  pullRequest.checkContexts = []
}

export const told = (turn: Turn | undefined) =>
  Predicate.isTagged(turn?.context, "PullRequestUpdate")
    ? turn.context.pullRequests.map(({ pullRequest, own, note, reasons }) => ({
        pullRequest: `${pullRequest.repo}#${pullRequest.number}`,
        own,
        note,
        reasons,
      }))
    : undefined

export const reasonsTold = (turn: Turn | undefined) =>
  told(turn)?.map(({ pullRequest, reasons }) => [
    pullRequest,
    reasons.map(({ _tag }) => _tag).join(),
  ])

export const failedRuns = (turn: Turn | undefined) =>
  told(turn)?.flatMap(({ reasons }) =>
    reasons.flatMap((reason) =>
      Predicate.isTagged(reason, "FailingChecks") ? reason.checks.map(({ url }) => url) : [],
    ),
  )

export const rerun = (pullRequest: FakePullRequest) => {
  pullRequest.checks = "PENDING"
  pullRequest.checkContexts = [running("lint")]
}

export const pushAgain = (pullRequest: FakePullRequest) => {
  pullRequest.checks = null
  pullRequest.checkContexts = []
}

export const failThreeTimes = Effect.fnUntraced(function* (
  f: Pick<Fixture, "client" | "transcript"> & {
    readonly thread: { readonly id: string }
    readonly pullRequest: FakePullRequest
  },
) {
  for (const run of [1, 2, 3]) {
    fail(f.pullRequest, failed("lint", run))
    yield* f.client.ListPullRequests()
    yield* f.transcript(f.thread.id, settled(2 + run))
    rerun(f.pullRequest)
    yield* f.client.ListPullRequests()
  }
})

import { defaultSubscriptionReasons, type SubscriptionReason, type Turn } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import type { FakeCheck, FakePullRequest } from "./fakePullRequest"
import { glassCall, settled } from "./threadsFixture"
import { threadWithPullRequest } from "./threadWithPullRequest"

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

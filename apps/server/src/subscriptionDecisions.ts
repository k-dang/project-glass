import type { PullRequestRef, ThreadPullRequest } from "@glass/contracts"
import { DateTime, Effect, Stream } from "effect"
import {
  type Mirror,
  mirroredPullRequest,
  mirroredRepositoryOf,
  PullRequestMirror,
} from "./PullRequestMirror"
import { decide, type Decision, PullRequestNow, type Told } from "./pullRequestUpdateDecision"
import { type SubscriptionState, Subscriptions } from "./Subscriptions"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Transcripts } from "./Transcripts"

interface SubscribedNow {
  readonly pullRequest: PullRequestRef
  readonly now: PullRequestNow
}

const subscribedNow = (
  { subscription, ended }: SubscriptionState,
  mirror: Mirror | undefined,
  own: ThreadPullRequest | undefined,
  readSince: DateTime.Utc | undefined,
): SubscribedNow | undefined => {
  if (ended !== null)
    return { pullRequest: ended.pullRequest, now: PullRequestNow.Ended({ state: ended.state }) }

  const pullRequest = subscription.pullRequest ?? own?.ref

  if (mirror === undefined || pullRequest === undefined) return undefined

  const readAt = mirroredRepositoryOf(mirror, pullRequest)?.syncedAt

  if (readSince !== undefined && (readAt === undefined || DateTime.isLessThan(readAt, readSince)))
    return undefined

  const mirrored = mirroredPullRequest(mirror, pullRequest)

  return mirrored?.attention == null || mirrored.details === null
    ? undefined
    : {
        pullRequest: mirrored.ref,
        now: PullRequestNow.Open({
          checks: mirrored.checks,
          failingChecks: mirrored.attention.failingChecks,
          mergeConflict: mirrored.attention.mergeConflict,
          details: mirrored.details,
        }),
      }
}

export interface SubscriptionDecision {
  readonly state: SubscriptionState
  readonly pullRequest: PullRequestRef
  readonly before: Told
  readonly decision: Decision
}

export const subscriptionDecisions = Effect.fnUntraced(function* (readSince?: DateTime.Utc) {
  const subscriptions = yield* Subscriptions
  const transcripts = yield* Transcripts
  const mirror = yield* PullRequestMirror
  const threadPullRequests = yield* ThreadPullRequests

  return Effect.fnUntraced(function* (threadId: string) {
    const states = yield* subscriptions.states(threadId)
    const mirrored = yield* mirror.saved
    const own = yield* threadPullRequests.ofThread(threadId)
    const lastMessageTurn = yield* transcripts.lastMessageTurn(threadId)

    const all = states.flatMap((state): ReadonlyArray<SubscriptionDecision> => {
      const subscribed = subscribedNow(state, mirrored, own, readSince)

      if (subscribed === undefined) return []

      const { pullRequest, now } = subscribed
      const before = state.toldAbout(pullRequest, lastMessageTurn)

      return [
        { state, pullRequest, before, decision: decide(state.subscription.reasons, now, before) },
      ]
    })

    return { all, lastMessageTurn }
  })
})

export const changed = (changes: ReadonlyArray<Stream.Stream<unknown, unknown>>) =>
  Stream.mergeAll(
    changes.map((change) =>
      change.pipe(
        Stream.catch((cause) =>
          Stream.fromEffect(
            Effect.logWarning("Stopped following a change PR updates are decided from", cause),
          ),
        ),
        Stream.as(undefined),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))

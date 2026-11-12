import {
  AgentNeedsYou,
  AgentReviewFinished,
  finishedReview,
  canRunQueueWork,
  type NeedsYouItem,
  PullRequestNeedsYou,
  type PullRequestReason,
  type PullRequestSummary,
  type QueuedPullRequest,
  referenceKey,
  ReviewRequested,
  WaitingRequests,
} from "@glass/contracts"
import { Array as Arr, Context, DateTime, Effect, Layer, Order, Predicate, Stream } from "effect"
import { AgentReviews } from "./AgentReviews"
import { Agents, type WaitingAgent } from "./Agents"
import { PullRequestLists, type RequestedReview } from "./PullRequestLists"
import { Queue } from "./Queue"

interface FinishedAgentReview {
  readonly pullRequest: PullRequestSummary
  readonly since: DateTime.Utc
}

interface PullRequestWait {
  readonly pullRequest: PullRequestSummary
  readonly reason: PullRequestReason
  readonly since: DateTime.Utc
}

const rank: Record<NeedsYouItem["_tag"], number> = { Agent: 0, PullRequest: 1 }

const order: Order.Order<NeedsYouItem> = Order.combine(
  Order.mapInput(Order.Number, (item: NeedsYouItem) => rank[item._tag]),
  Order.mapInput(DateTime.Order, (item: NeedsYouItem) => item.since),
)

const byUpdatedAt = Order.mapInput(
  DateTime.Order,
  (summary: PullRequestSummary) => summary.updatedAt,
)

const agentItem = ({ agent, requests }: WaitingAgent) =>
  AgentNeedsYou.make({
    agent,
    reasons: [WaitingRequests.make({ requests: Arr.map(requests, ({ part }) => part) })],
    since: Arr.min(
      Arr.map(requests, ({ since }) => since),
      DateTime.Order,
    ),
  })

const pullRequestItem = (waits: Arr.NonEmptyReadonlyArray<PullRequestWait>) =>
  PullRequestNeedsYou.make({
    pullRequest: Arr.max(
      Arr.map(waits, ({ pullRequest }) => pullRequest),
      byUpdatedAt,
    ),
    reasons: Arr.map(waits, ({ reason }) => reason),
    since: Arr.min(
      Arr.map(waits, ({ since }) => since),
      DateTime.Order,
    ),
  })

const needsYouOf = (
  waiting: ReadonlyArray<WaitingAgent>,
  requested: ReadonlyArray<RequestedReview>,
  finished: ReadonlyArray<FinishedAgentReview>,
): ReadonlyArray<NeedsYouItem> => {
  const waits: ReadonlyArray<PullRequestWait> = [
    ...requested.map(({ pullRequest, since }) => ({
      pullRequest,
      since,
      reason: ReviewRequested.make({}),
    })),
    ...finished.map(({ pullRequest, since }) => ({
      pullRequest,
      since,
      reason: AgentReviewFinished.make({}),
    })),
  ]

  return Arr.sort(
    [
      ...waiting.map(agentItem),
      ...Object.values(Arr.groupBy(waits, ({ pullRequest }) => referenceKey(pullRequest.ref))).map(
        pullRequestItem,
      ),
    ],
    order,
  )
}

const reviewable = (queued: ReadonlyArray<QueuedPullRequest>) =>
  queued.flatMap((row) => (canRunQueueWork(row) ? [row.pullRequest] : []))

const samePullRequests = (
  before: ReadonlyArray<PullRequestSummary>,
  after: ReadonlyArray<PullRequestSummary>,
) =>
  before.length === after.length &&
  before.every((summary, index) => {
    const next = after[index]

    return (
      next !== undefined &&
      referenceKey(summary.ref) === referenceKey(next.ref) &&
      DateTime.Equivalence(summary.updatedAt, next.updatedAt)
    )
  })

export class NeedsYou extends Context.Service<
  NeedsYou,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<NeedsYouItem>>
  }
>()("@glass/server/NeedsYou") {
  static readonly layer = Layer.effect(
    NeedsYou,
    Effect.gen(function* () {
      const agents = yield* Agents
      const lists = yield* PullRequestLists
      const queue = yield* Queue
      const agentReviews = yield* AgentReviews

      const finishedReviewOf = (pullRequest: PullRequestSummary) =>
        agentReviews.watch(pullRequest.ref).pipe(
          Stream.map((state): FinishedAgentReview | null => {
            const review = finishedReview(state)

            return review === null ? null : { pullRequest, since: review.writtenAt }
          }),
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.logWarning("Couldn't read a queued PR's Agent review", cause).pipe(
                Effect.as(null),
              ),
            ),
          ),
        )

      const finishedAgentReviews: Stream.Stream<ReadonlyArray<FinishedAgentReview>> = queue
        .watch()
        .pipe(
          Stream.map(reviewable),
          Stream.changesWith(samePullRequests),
          Stream.switchMap((pullRequests): Stream.Stream<ReadonlyArray<FinishedAgentReview>> =>
            Arr.isReadonlyArrayNonEmpty(pullRequests)
              ? Stream.zipLatestAll(...pullRequests.map(finishedReviewOf)).pipe(
                  Stream.map(Arr.filter(Predicate.isNotNull)),
                )
              : Stream.make([]),
          ),
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.logWarning("Couldn't read the Queue for Needs you", cause).pipe(
                Effect.as<ReadonlyArray<FinishedAgentReview>>([]),
              ),
            ),
          ),
        )

      return NeedsYou.of({
        watch: () =>
          Stream.zipLatestAll(
            agents.watchWaiting(),
            lists.watchNeedsReview(),
            finishedAgentReviews,
          ).pipe(
            Stream.map(([waiting, requested, finished]) =>
              needsYouOf(waiting, requested, finished),
            ),
          ),
      })
    }),
  )
}

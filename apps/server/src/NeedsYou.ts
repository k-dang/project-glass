import {
  AgentNeedsYou,
  AgentReviewFinished,
  finishedReview,
  canRunQueueWork,
  type NeedsYouItem,
  type OutsideQuestion,
  PullRequestNeedsYou,
  type PullRequestSummary,
  type QueuedPullRequest,
  referenceKey,
  WaitingRequests,
} from "@glass/contracts"
import { Array as Arr, Context, DateTime, Effect, Layer, Order, Predicate, Stream } from "effect"
import { AgentReviews } from "./AgentReviews"
import { Agents, type WaitingAgent } from "./Agents"
import { OutsideQuestions } from "./OutsideQuestions"
import { Queue } from "./Queue"

interface FinishedAgentReview {
  readonly pullRequest: PullRequestSummary
  readonly since: DateTime.Utc
}

const rank: Record<NeedsYouItem["_tag"], number> = {
  Agent: 0,
  OutsideQuestion: 0,
  PullRequest: 1,
}

const order: Order.Order<NeedsYouItem> = Order.combine(
  Order.mapInput(Order.Number, (item: NeedsYouItem) => rank[item._tag]),
  Order.mapInput(DateTime.Order, (item: NeedsYouItem) => item.since),
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

const pullRequestItem = ({ pullRequest, since }: FinishedAgentReview) =>
  PullRequestNeedsYou.make({
    pullRequest,
    reasons: [AgentReviewFinished.make({})],
    since,
  })

const needsYouOf = (
  waiting: ReadonlyArray<WaitingAgent>,
  finished: ReadonlyArray<FinishedAgentReview>,
  outside: ReadonlyArray<OutsideQuestion>,
): ReadonlyArray<NeedsYouItem> =>
  Arr.sort([...waiting.map(agentItem), ...outside, ...finished.map(pullRequestItem)], order)

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
      const queue = yield* Queue
      const agentReviews = yield* AgentReviews
      const questions = yield* OutsideQuestions

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
          Stream.zipLatestAll(agents.watchWaiting(), finishedAgentReviews, questions.watch()).pipe(
            Stream.map(([waiting, finished, asked]) => needsYouOf(waiting, finished, asked)),
          ),
      })
    }),
  )
}

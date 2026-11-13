import {
  AgentNeedsYou,
  AgentReviewFinished,
  AwaitingReply,
  ChangesRequested,
  ChecksFailing,
  finishedReview,
  GlobalConversationNeedsYou,
  canRunQueueWork,
  type NeedsYouItem,
  NeedsYou as NeedsYouList,
  type OutsideQuestion,
  PullRequestNeedsYou,
  type PullRequestReason,
  type PullRequestSummary,
  type QueuedPullRequest,
  ReadyToMerge,
  referenceKey,
  stopsOnYou,
  TurnFinished,
  WaitingRequests,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Order,
  Predicate,
  Schema,
  Stream,
} from "effect"
import { AgentReviews } from "./AgentReviews"
import { Agents, type FinishedAgent, type WaitingAgent } from "./Agents"
import { GlobalConversation } from "./GlobalConversation"
import { OutsideQuestions } from "./OutsideQuestions"
import {
  type Mirror,
  type MirroredPullRequest,
  PullRequestMirror,
  summaryOf,
} from "./PullRequestMirror"
import { Queue } from "./Queue"
import type { WaitingRequest } from "./Transcripts"

interface WaitingPullRequest {
  readonly pullRequest: PullRequestSummary
  readonly reasons: Arr.NonEmptyReadonlyArray<PullRequestReason>
  readonly since: DateTime.Utc
}

const order: Order.Order<NeedsYouItem> = Order.combine(
  Order.mapInput(Order.Number, (item: NeedsYouItem) => (stopsOnYou(item) ? 0 : 1)),
  Order.mapInput(DateTime.Order, (item: NeedsYouItem) => item.since),
)

const waitingOn = (requests: Arr.NonEmptyReadonlyArray<WaitingRequest>) => ({
  requests: Arr.map(requests, ({ part }) => part),
  since: Arr.min(
    Arr.map(requests, ({ since }) => since),
    DateTime.Order,
  ),
})

const waitingItem = ({ agent, requests }: WaitingAgent) => {
  const { requests: parts, since } = waitingOn(requests)

  return AgentNeedsYou.make({
    agent,
    reasons: [WaitingRequests.make({ requests: parts })],
    since,
  })
}

const globalItem = (requests: ReadonlyArray<WaitingRequest>) =>
  Arr.isReadonlyArrayNonEmpty(requests)
    ? [GlobalConversationNeedsYou.make(waitingOn(requests))]
    : []

const finishedItem = ({ agent, ended }: FinishedAgent) =>
  AgentNeedsYou.make({ agent, reasons: [TurnFinished.make({ ended })], since: ended.at })

const pullRequestItems = (waiting: ReadonlyArray<WaitingPullRequest>) =>
  Object.values(Arr.groupBy(waiting, ({ pullRequest }) => referenceKey(pullRequest.ref))).map(
    (group) =>
      PullRequestNeedsYou.make({
        pullRequest: group[0].pullRequest,
        reasons: Arr.flatMap(group, ({ reasons }) => reasons),
        since: Arr.min(
          Arr.map(group, ({ since }) => since),
          DateTime.Order,
        ),
      }),
  )

const needsYouOf = (
  waiting: ReadonlyArray<WaitingAgent>,
  finished: ReadonlyArray<FinishedAgent>,
  pullRequests: ReadonlyArray<WaitingPullRequest>,
  outside: ReadonlyArray<OutsideQuestion>,
  global: ReadonlyArray<WaitingRequest>,
): ReadonlyArray<NeedsYouItem> =>
  Arr.sort(
    [
      ...waiting.map(waitingItem),
      ...finished.map(finishedItem),
      ...outside,
      ...globalItem(global),
      ...pullRequestItems(pullRequests),
    ],
    order,
  )

const reasonsOf = ({
  attention,
  checks,
}: MirroredPullRequest): ReadonlyArray<PullRequestReason> => {
  const reasons: Array<PullRequestReason> = []

  if (attention?.changesRequested) reasons.push(ChangesRequested.make({}))

  if (checks === "failing") reasons.push(ChecksFailing.make({}))

  if (attention && attention.awaitingReply > 0) {
    reasons.push(AwaitingReply.make({ threads: attention.awaitingReply }))
  }

  if (reasons.length === 0 && attention?.approved && attention.mergeClean) {
    reasons.push(ReadyToMerge.make({}))
  }

  return reasons
}

const yourPullRequests = (mirror: Mirror | undefined): ReadonlyArray<WaitingPullRequest> =>
  (mirror?.repositories ?? []).flatMap(({ pullRequests }) =>
    pullRequests.flatMap((pr) => {
      const reasons = reasonsOf(pr)

      return pr.viewerIsAuthor && Arr.isReadonlyArrayNonEmpty(reasons)
        ? [{ pullRequest: summaryOf(pr), reasons, since: pr.updatedAt }]
        : []
    }),
  )

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
      const mirror = yield* PullRequestMirror
      const conversation = yield* GlobalConversation

      const finishedReviewOf = (pullRequest: PullRequestSummary) =>
        agentReviews.watch(pullRequest.ref).pipe(
          Stream.map((state): WaitingPullRequest | null => {
            const review = finishedReview(state)

            return review === null || review.done || review.reported
              ? null
              : {
                  pullRequest,
                  reasons: [AgentReviewFinished.make({ writtenAt: review.writtenAt })],
                  since: review.writtenAt,
                }
          }),
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.logWarning("Couldn't read a queued PR's Agent review", cause).pipe(
                Effect.as(null),
              ),
            ),
          ),
        )

      const finishedAgentReviews: Stream.Stream<ReadonlyArray<WaitingPullRequest>> = queue
        .watch()
        .pipe(
          Stream.map(reviewable),
          Stream.changesWith(samePullRequests),
          Stream.switchMap((pullRequests): Stream.Stream<ReadonlyArray<WaitingPullRequest>> =>
            Arr.isReadonlyArrayNonEmpty(pullRequests)
              ? Stream.zipLatestAll(...pullRequests.map(finishedReviewOf)).pipe(
                  Stream.map(Arr.filter(Predicate.isNotNull)),
                )
              : Stream.make([]),
          ),
          Stream.catch((cause) =>
            Stream.fromEffect(
              Effect.logWarning("Couldn't read the Queue for Needs you", cause).pipe(
                Effect.as<ReadonlyArray<WaitingPullRequest>>([]),
              ),
            ),
          ),
        )

      const waitingPullRequests = Stream.zipLatest(
        finishedAgentReviews,
        mirror.changes.pipe(Stream.map(yourPullRequests)),
      ).pipe(Stream.map(([finished, yours]) => [...finished, ...yours]))

      return NeedsYou.of({
        watch: () =>
          Stream.zipLatestAll(
            agents.watchWaiting(),
            agents.watchFinished(),
            waitingPullRequests,
            questions.watch(),
            conversation.waiting,
          ).pipe(
            Stream.map(([waiting, finished, pullRequests, asked, global]) =>
              needsYouOf(waiting, finished, pullRequests, asked, global),
            ),
            Stream.changesWith(Schema.toEquivalence(NeedsYouList)),
          ),
      })
    }),
  )
}

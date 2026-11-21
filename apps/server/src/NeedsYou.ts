import {
  type CheckIn,
  ConversationNeedsYou,
  AgentReviewFinished,
  AwaitingReply,
  ChangesRequested,
  ChecksFailing,
  finishedReview,
  splitLead,
  GlobalChatNeedsYou,
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
  needsYouGroupOf,
  needsYouGroups,
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
import { CheckIns } from "./CheckIns"
import { Conversations, type FinishedConversation, type WaitingConversation } from "./Conversations"
import { GlobalChat } from "./GlobalChat"
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
  Order.mapInput(Order.Number, (item: NeedsYouItem) =>
    needsYouGroups.indexOf(needsYouGroupOf(item)),
  ),
  Order.mapInput(DateTime.Order, (item: NeedsYouItem) => item.since),
)

const waitingOn = (requests: Arr.NonEmptyReadonlyArray<WaitingRequest>) => ({
  requests: Arr.map(requests, ({ part }) => part),
  since: Arr.min(
    Arr.map(requests, ({ since }) => since),
    DateTime.Order,
  ),
})

const waitingItem = ({ conversation, requests }: WaitingConversation) => {
  const { requests: parts, since } = waitingOn(requests)

  return ConversationNeedsYou.make({
    conversation,
    reasons: [WaitingRequests.make({ requests: parts })],
    since,
  })
}

const globalItem = (requests: ReadonlyArray<WaitingRequest>) =>
  Arr.isReadonlyArrayNonEmpty(requests) ? [GlobalChatNeedsYou.make(waitingOn(requests))] : []

const finishedItem = ({ conversation, ended }: FinishedConversation) =>
  ConversationNeedsYou.make({
    conversation,
    reasons: [TurnFinished.make({ ended })],
    since: ended.at,
  })

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

interface Waiting {
  readonly conversations: ReadonlyArray<WaitingConversation>
  readonly finished: ReadonlyArray<FinishedConversation>
  readonly pullRequests: ReadonlyArray<WaitingPullRequest>
  readonly questions: ReadonlyArray<OutsideQuestion>
  readonly checkIns: ReadonlyArray<CheckIn>
  readonly global: ReadonlyArray<WaitingRequest>
}

const needsYouOf = (waiting: Waiting): ReadonlyArray<NeedsYouItem> =>
  Arr.sort(
    [
      ...waiting.conversations.map(waitingItem),
      ...waiting.finished.map(finishedItem),
      ...waiting.questions,
      ...waiting.checkIns,
      ...globalItem(waiting.global),
      ...pullRequestItems(waiting.pullRequests),
    ],
    order,
  )

const reasonsOf = ({
  attention,
  checks,
}: MirroredPullRequest): ReadonlyArray<PullRequestReason> => {
  const reasons: Array<PullRequestReason> = []

  if (attention?.changesRequested) reasons.push(ChangesRequested.make({}))

  if (checks === "failing") {
    reasons.push(ChecksFailing.make({ failing: attention?.failingChecks ?? [] }))
  }

  if (attention && attention.awaitingReply > 0) {
    reasons.push(AwaitingReply.make({ reviewThreads: attention.awaitingReply }))
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
      const conversations = yield* Conversations
      const queue = yield* Queue
      const agentReviews = yield* AgentReviews
      const questions = yield* OutsideQuestions
      const checkIns = yield* CheckIns
      const mirror = yield* PullRequestMirror
      const globalChat = yield* GlobalChat

      const finishedReviewOf = (pullRequest: PullRequestSummary) =>
        agentReviews.watch(pullRequest.ref).pipe(
          Stream.map((state): WaitingPullRequest | null => {
            const review = finishedReview(state)

            return review === null || review.done || review.includedInStartedWorkUpdate
              ? null
              : {
                  pullRequest,
                  reasons: [
                    AgentReviewFinished.make({
                      writtenAt: review.writtenAt,
                      lead: splitLead(review.markdown).lead,
                    }),
                  ],
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
            conversations.watchWaiting(),
            conversations.watchFinished(),
            waitingPullRequests,
            questions.watch(),
            checkIns.watch(),
            globalChat.waiting,
          ).pipe(
            Stream.map(([waiting, finished, pullRequests, asked, checkingIn, global]) =>
              needsYouOf({
                conversations: waiting,
                finished,
                pullRequests,
                questions: asked,
                checkIns: checkingIn,
                global,
              }),
            ),
            Stream.changesWith(Schema.toEquivalence(NeedsYouList)),
          ),
      })
    }),
  )
}

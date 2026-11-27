import {
  type CheckIn,
  InboxThread,
  AgentReviewFinished,
  AwaitingReply,
  ChangesRequested,
  ChecksFailing,
  finishedReview,
  splitLead,
  InboxGlobalChat,
  canRunQueueWork,
  type InboxItem,
  InboxItems,
  type OutsideAgentRequest,
  type OutsideQuestion,
  InboxPullRequest,
  type PullRequestReason,
  type PullRequestSummary,
  type QueuedPullRequest,
  ReadyToMerge,
  referenceKey,
  inboxGroupOf,
  inboxGroups,
  type OpenReason,
  type TriedThread,
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
import { Threads, type FinishedThread, type WaitingThread } from "./Threads"
import { GlobalChat } from "./GlobalChat"
import { McpOAuth } from "./mcp/McpOAuth"
import { OutsideQuestions } from "./OutsideQuestions"
import {
  type Mirror,
  type MirroredPullRequest,
  PullRequestMirror,
  summaryOf,
} from "./PullRequestMirror"
import { type PullRequestStanding, PullRequestStandings } from "./PullRequestStandings"
import { partitionFeedback } from "./pullRequestNow"
import { Queue } from "./Queue"
import type { WaitingRequest } from "./Transcripts"

interface WaitingPullRequest {
  readonly pullRequest: PullRequestSummary
  readonly reasons: Arr.NonEmptyReadonlyArray<PullRequestReason>
  readonly triedBy: ReadonlyArray<TriedThread>
  readonly since: DateTime.Utc
}

const order: Order.Order<InboxItem> = Order.combine(
  Order.mapInput(Order.Number, (item: InboxItem) => inboxGroups.indexOf(inboxGroupOf(item))),
  Order.mapInput(DateTime.Order, (item: InboxItem) => item.since),
)

const waitingOn = (requests: Arr.NonEmptyReadonlyArray<WaitingRequest>) => ({
  requests: Arr.map(requests, ({ part }) => part),
  since: Arr.min(
    Arr.map(requests, ({ since }) => since),
    DateTime.Order,
  ),
})

const waitingItem = ({ thread, requests }: WaitingThread) => {
  const { requests: parts, since } = waitingOn(requests)

  return InboxThread.make({
    thread,
    reasons: [WaitingRequests.make({ requests: parts })],
    since,
  })
}

const globalItem = (requests: ReadonlyArray<WaitingRequest>) =>
  Arr.isReadonlyArrayNonEmpty(requests) ? [InboxGlobalChat.make(waitingOn(requests))] : []

const finishedItem = ({ thread, ended }: FinishedThread) =>
  InboxThread.make({
    thread,
    reasons: [TurnFinished.make({ ended })],
    since: ended.at,
  })

const pullRequestItems = (waiting: ReadonlyArray<WaitingPullRequest>) =>
  Object.values(Arr.groupBy(waiting, ({ pullRequest }) => referenceKey(pullRequest.ref))).map(
    (group) =>
      InboxPullRequest.make({
        pullRequest: group[0].pullRequest,
        reasons: Arr.flatMap(group, ({ reasons }) => reasons),
        triedBy: group.flatMap(({ triedBy }) => triedBy),
        since: Arr.min(
          Arr.map(group, ({ since }) => since),
          DateTime.Order,
        ),
      }),
  )

interface Waiting {
  readonly threads: ReadonlyArray<WaitingThread>
  readonly finished: ReadonlyArray<FinishedThread>
  readonly pullRequests: ReadonlyArray<WaitingPullRequest>
  readonly questions: ReadonlyArray<OutsideQuestion>
  readonly checkIns: ReadonlyArray<CheckIn>
  readonly outsideAgentRequests: ReadonlyArray<OutsideAgentRequest>
  readonly global: ReadonlyArray<WaitingRequest>
}

const inboxOf = (waiting: Waiting): InboxItems =>
  Arr.sort(
    [
      ...waiting.threads.map(waitingItem),
      ...waiting.finished.flatMap((finished) =>
        finished.update && Predicate.isTagged(finished.ended.ending, "Done")
          ? []
          : [finishedItem(finished)],
      ),
      ...waiting.questions,
      ...waiting.checkIns,
      ...waiting.outsideAgentRequests,
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

const openReasonOf: Partial<Record<PullRequestReason["_tag"], OpenReason>> = {
  ChangesRequested: "changes-requested",
  ChecksFailing: "failing-checks",
  AwaitingReply: "review-feedback",
}

const heldBackOf = (
  reason: PullRequestReason,
  { details }: MirroredPullRequest,
): ReadonlyArray<PullRequestReason> => {
  if (details === null) return []

  const { changesRequested, reviewThreads } = partitionFeedback(details).heldBack

  if (Predicate.isTagged(reason, "ChangesRequested"))
    return changesRequested.length > 0 ? [reason] : []

  return Predicate.isTagged(reason, "AwaitingReply") && reviewThreads.length > 0
    ? [AwaitingReply.make({ reviewThreads: reviewThreads.length })]
    : []
}

const leftToYou = (pr: MirroredPullRequest, standings: ReadonlyArray<PullRequestStanding>) => {
  const left = reasonsOf(pr).map((reason) => {
    const standing = standings.filter((candidate) => candidate.reason === openReasonOf[reason._tag])

    return standing.some(({ state }) => state === "handling")
      ? { reasons: heldBackOf(reason, pr), triedBy: [] }
      : {
          reasons: [reason],
          triedBy: standing.map(({ thread }): TriedThread => ({
            threadId: thread.id,
            name: thread.name,
          })),
        }
  })

  return {
    reasons: left.flatMap(({ reasons }) => reasons),
    triedBy: Arr.dedupeWith(
      left.flatMap(({ triedBy }) => triedBy),
      (a, b) => a.threadId === b.threadId,
    ),
  }
}

const yourPullRequests = (
  mirror: Mirror | undefined,
  standings: ReadonlyArray<PullRequestStanding>,
): ReadonlyArray<WaitingPullRequest> => {
  const standingsOf = Arr.groupBy(standings, ({ pullRequest }) => referenceKey(pullRequest))

  return (mirror?.repositories ?? []).flatMap(({ pullRequests }) =>
    pullRequests.flatMap((pr) => {
      if (!pr.viewerIsAuthor) return []

      const { reasons, triedBy } = leftToYou(pr, standingsOf[referenceKey(pr.ref)] ?? [])

      return Arr.isReadonlyArrayNonEmpty(reasons)
        ? [{ pullRequest: summaryOf(pr), reasons, triedBy, since: pr.updatedAt }]
        : []
    }),
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

export class Inbox extends Context.Service<
  Inbox,
  {
    readonly watch: () => Stream.Stream<InboxItems>
  }
>()("@glass/server/Inbox") {
  static readonly layer = Layer.effect(
    Inbox,
    Effect.gen(function* () {
      const threads = yield* Threads
      const queue = yield* Queue
      const agentReviews = yield* AgentReviews
      const questions = yield* OutsideQuestions
      const checkIns = yield* CheckIns
      const mirror = yield* PullRequestMirror
      const globalChat = yield* GlobalChat
      const oauth = yield* McpOAuth
      const standings = yield* PullRequestStandings

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
                  triedBy: [],
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
              Effect.logWarning("Couldn't read the Queue for the Inbox", cause).pipe(
                Effect.as<ReadonlyArray<WaitingPullRequest>>([]),
              ),
            ),
          ),
        )

      const waitingPullRequests = Stream.zipLatest(
        finishedAgentReviews,
        Stream.zipLatest(mirror.changes, standings.watch()).pipe(
          Stream.map(([mirrored, standing]) => yourPullRequests(mirrored, standing)),
        ),
      ).pipe(Stream.map(([finished, yours]) => [...finished, ...yours]))

      return Inbox.of({
        watch: () =>
          Stream.zipLatestAll(
            threads.watchWaiting(),
            threads.watchFinished(),
            waitingPullRequests,
            questions.watch(),
            checkIns.watch(),
            oauth.watchRequests(),
            globalChat.waiting,
          ).pipe(
            Stream.map(([waiting, finished, pullRequests, asked, checkingIn, connecting, global]) =>
              inboxOf({
                threads: waiting,
                finished,
                pullRequests,
                questions: asked,
                checkIns: checkingIn,
                outsideAgentRequests: connecting,
                global,
              }),
            ),
            Stream.changesWith(Schema.toEquivalence(InboxItems)),
          ),
      })
    }),
  )
}

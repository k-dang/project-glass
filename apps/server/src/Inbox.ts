import {
  type CheckIn,
  InboxThread,
  type OpenQuestion,
  OpenQuestions,
  type Thread,
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
  OutsideQuestion,
  InboxPullRequest,
  type PullRequestReason,
  type PullRequestSummary,
  type QueuedPullRequest,
  ReadyToMerge,
  referenceKey,
  inboxGroupOf,
  inboxGroups,
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
import { type AskedQuestion, Questions } from "./Questions"
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

const order: Order.Order<InboxItem> = Order.combine(
  Order.mapInput(Order.Number, (item: InboxItem) => inboxGroups.indexOf(inboxGroupOf(item))),
  Order.mapInput(DateTime.Order, (item: InboxItem) => item.since),
)

const earliest = (waiting: Arr.NonEmptyReadonlyArray<{ readonly since: DateTime.Utc }>) =>
  Arr.min(
    Arr.map(waiting, ({ since }) => since),
    DateTime.Order,
  )

const waitingItem = ({ thread, requests }: WaitingThread) =>
  InboxThread.make({
    thread,
    reasons: [WaitingRequests.make({ requests: Arr.map(requests, ({ part }) => part) })],
    since: earliest(requests),
  })

const globalItem = (
  requests: ReadonlyArray<WaitingRequest>,
  asked: ReadonlyArray<AskedQuestion>,
) => {
  const questions = asked.flatMap(({ asker, question }) =>
    Predicate.isTagged(asker, "GlobalChat") ? [question] : [],
  )

  const waiting = [...requests, ...questions]

  return Arr.isReadonlyArrayNonEmpty(waiting)
    ? [
        InboxGlobalChat.make({
          requests: requests.map(({ part }) => part),
          questions,
          since: earliest(waiting),
        }),
      ]
    : []
}

const finishedItem = ({ thread, ended }: FinishedThread) =>
  InboxThread.make({
    thread,
    reasons: [TurnFinished.make({ ended })],
    since: ended.at,
  })

interface AskingThread {
  readonly thread: Thread
  readonly questions: Arr.NonEmptyReadonlyArray<OpenQuestion>
}

const askingThreads = (
  threads: ReadonlyArray<Thread>,
  byThread: ReadonlyMap<string, Arr.NonEmptyReadonlyArray<OpenQuestion>>,
) =>
  threads.flatMap((thread) => {
    const questions = byThread.get(thread.id)

    return questions === undefined ? [] : [{ thread, questions }]
  })

const askingItem = ({ thread, questions }: AskingThread) =>
  InboxThread.make({
    thread,
    reasons: [OpenQuestions.make({ questions })],
    since: earliest(questions),
  })

const threadItems = (items: ReadonlyArray<InboxThread>) =>
  Object.values(Arr.groupBy(items, ({ thread }) => thread.id)).map((group) =>
    InboxThread.make({
      thread: group[0].thread,
      reasons: Arr.flatMap(group, ({ reasons }) => reasons),
      since: earliest(group),
    }),
  )

const pullRequestItems = (waiting: ReadonlyArray<WaitingPullRequest>) =>
  Object.values(Arr.groupBy(waiting, ({ pullRequest }) => referenceKey(pullRequest.ref))).map(
    (group) =>
      InboxPullRequest.make({
        pullRequest: group[0].pullRequest,
        reasons: Arr.flatMap(group, ({ reasons }) => reasons),
        since: earliest(group),
      }),
  )

interface Waiting {
  readonly asking: ReadonlyArray<AskingThread>
  readonly threads: ReadonlyArray<WaitingThread>
  readonly finished: ReadonlyArray<FinishedThread>
  readonly pullRequests: ReadonlyArray<WaitingPullRequest>
  readonly questions: ReadonlyArray<AskedQuestion>
  readonly checkIns: ReadonlyArray<CheckIn>
  readonly outsideAgentRequests: ReadonlyArray<OutsideAgentRequest>
  readonly global: ReadonlyArray<WaitingRequest>
}

const inboxOf = (waiting: Waiting): InboxItems =>
  Arr.sort(
    [
      ...threadItems([
        ...waiting.asking.map(askingItem),
        ...waiting.threads.map(waitingItem),
        ...waiting.finished.map(finishedItem),
      ]),
      ...outsideQuestions(waiting.questions),
      ...waiting.checkIns,
      ...waiting.outsideAgentRequests,
      ...globalItem(waiting.global, waiting.questions),
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

const outsideQuestions = (asked: ReadonlyArray<AskedQuestion>) =>
  asked.flatMap(({ asker, question }) =>
    Predicate.isTagged(asker, "OutsideAgent")
      ? [OutsideQuestion.make({ ...question, askedBy: asker.name })]
      : [],
  )

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
      const questions = yield* Questions
      const checkIns = yield* CheckIns
      const mirror = yield* PullRequestMirror
      const globalChat = yield* GlobalChat
      const oauth = yield* McpOAuth

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
              Effect.logWarning("Couldn't read the Queue for the Inbox", cause).pipe(
                Effect.as<ReadonlyArray<WaitingPullRequest>>([]),
              ),
            ),
          ),
        )

      const waitingPullRequests = Stream.zipLatest(
        finishedAgentReviews,
        mirror.changes.pipe(Stream.map(yourPullRequests)),
      ).pipe(Stream.map(([finished, yours]) => [...finished, ...yours]))

      return Inbox.of({
        watch: () =>
          Stream.zipLatestAll(
            Stream.zipLatest(
              threads
                .watch()
                .pipe(
                  Stream.catch((cause) =>
                    Stream.fromEffect(
                      Effect.logWarning("Couldn't read the Threads for the Inbox", cause).pipe(
                        Effect.as<ReadonlyArray<Thread>>([]),
                      ),
                    ),
                  ),
                ),
              questions.openByThread,
            ).pipe(Stream.map(([listed, byThread]) => askingThreads(listed, byThread))),
            threads.watchWaiting(),
            threads.watchFinished(),
            waitingPullRequests,
            questions.open,
            checkIns.watch(),
            oauth.watchRequests(),
            globalChat.waiting,
          ).pipe(
            Stream.map(
              ([asking, waiting, finished, pullRequests, asked, checkingIn, connecting, global]) =>
                inboxOf({
                  asking,
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

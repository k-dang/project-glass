import { Match, Predicate, Schema } from "effect"
import { CheckIn } from "./checkIn"
import { OpenQuestion } from "./question"
import { Thread, PermissionRequestPart, QuestionPart, TurnEnd } from "./thread"
import { Check } from "./pullRequest"
import { PullRequestSummary } from "./pullRequestList"

const WaitingRequestParts = Schema.NonEmptyArray(
  Schema.Union([PermissionRequestPart, QuestionPart]),
)

export const WaitingRequests = Schema.TaggedStruct("WaitingRequests", {
  requests: WaitingRequestParts,
})

export const TurnFinished = Schema.TaggedStruct("TurnFinished", { ended: TurnEnd })

export const TurnSeen = Schema.Struct({
  threadId: Schema.String,
  endedAt: Schema.DateTimeUtcFromString,
})

export type TurnSeen = typeof TurnSeen.Type

export const OpenQuestions = Schema.TaggedStruct("OpenQuestions", {
  questions: Schema.NonEmptyArray(OpenQuestion),
})

const ThreadReason = Schema.Union([OpenQuestions, WaitingRequests, TurnFinished])

type ThreadReason = typeof ThreadReason.Type

export const waitsOnYou = (reason: ThreadReason) =>
  Predicate.isTagged(reason, "WaitingRequests") || Predicate.isTagged(reason, "OpenQuestions")

export const AgentReviewFinished = Schema.TaggedStruct("AgentReviewFinished", {
  writtenAt: Schema.DateTimeUtcFromString,
  lead: Schema.String,
})

export const ChangesRequested = Schema.TaggedStruct("ChangesRequested", {})

export const ChecksFailing = Schema.TaggedStruct("ChecksFailing", {
  failing: Schema.Array(Check),
})

export const AwaitingReply = Schema.TaggedStruct("AwaitingReply", { reviewThreads: Schema.Int })

export const ReadyToMerge = Schema.TaggedStruct("ReadyToMerge", {})

export const PullRequestReason = Schema.Union([
  AgentReviewFinished,
  ChangesRequested,
  ChecksFailing,
  AwaitingReply,
  ReadyToMerge,
])

export type PullRequestReason = typeof PullRequestReason.Type

export const InboxThread = Schema.TaggedStruct("Thread", {
  thread: Thread,
  reasons: Schema.NonEmptyArray(ThreadReason),
  since: Schema.DateTimeUtcFromString,
})

export type InboxThread = typeof InboxThread.Type

export const InboxPullRequest = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestSummary,
  reasons: Schema.NonEmptyArray(PullRequestReason),
  since: Schema.DateTimeUtcFromString,
})

export type InboxPullRequest = typeof InboxPullRequest.Type

export const OutsideQuestion = Schema.TaggedStruct("OutsideQuestion", {
  ...OpenQuestion.fields,
  askedBy: Schema.String,
})

export type OutsideQuestion = typeof OutsideQuestion.Type

export const InboxGlobalChat = Schema.TaggedStruct("GlobalChat", {
  requests: Schema.Array(Schema.Union([PermissionRequestPart, QuestionPart])),
  questions: Schema.Array(OpenQuestion),
  since: Schema.DateTimeUtcFromString,
})

export type InboxGlobalChat = typeof InboxGlobalChat.Type

export const InboxItem = Schema.Union([
  InboxThread,
  InboxPullRequest,
  OutsideQuestion,
  CheckIn,
  InboxGlobalChat,
])

export type InboxItem = typeof InboxItem.Type

export const InboxItems = Schema.Array(InboxItem)

export type InboxItems = typeof InboxItems.Type

export const inboxGroups = ["stopped", "reviews", "mine", "finished"] as const

export type InboxGroup = (typeof inboxGroups)[number]

export const inboxGroupOf = (item: InboxItem): InboxGroup =>
  Match.valueTags(item, {
    OutsideQuestion: () => "stopped" as const,
    CheckIn: () => "stopped" as const,
    GlobalChat: () => "stopped" as const,
    Thread: ({ reasons }) =>
      reasons.some(waitsOnYou) ? ("stopped" as const) : ("finished" as const),
    PullRequest: ({ reasons }) =>
      reasons.some(Predicate.isTagged("AgentReviewFinished"))
        ? ("reviews" as const)
        : ("mine" as const),
  })

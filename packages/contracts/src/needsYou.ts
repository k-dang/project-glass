import { Match, Predicate, Schema } from "effect"
import { Agent, PermissionRequestPart, QuestionPart, TurnEnd } from "./agent"
import { Check } from "./pullRequest"
import { PullRequestSummary } from "./pullRequestList"

const WaitingRequestParts = Schema.NonEmptyArray(
  Schema.Union([PermissionRequestPart, QuestionPart]),
)

export const WaitingRequests = Schema.TaggedStruct("WaitingRequests", {
  requests: WaitingRequestParts,
})

export const TurnFinished = Schema.TaggedStruct("TurnFinished", { ended: TurnEnd })

export const AgentReason = Schema.Union([WaitingRequests, TurnFinished])

export type AgentReason = typeof AgentReason.Type

export const AgentReviewFinished = Schema.TaggedStruct("AgentReviewFinished", {
  writtenAt: Schema.DateTimeUtcFromString,
  lead: Schema.String,
})

export const ChangesRequested = Schema.TaggedStruct("ChangesRequested", {})

export const ChecksFailing = Schema.TaggedStruct("ChecksFailing", {
  failing: Schema.Array(Check),
})

export const AwaitingReply = Schema.TaggedStruct("AwaitingReply", { threads: Schema.Int })

export const ReadyToMerge = Schema.TaggedStruct("ReadyToMerge", {})

export const PullRequestReason = Schema.Union([
  AgentReviewFinished,
  ChangesRequested,
  ChecksFailing,
  AwaitingReply,
  ReadyToMerge,
])

export type PullRequestReason = typeof PullRequestReason.Type

export const AgentNeedsYou = Schema.TaggedStruct("Agent", {
  agent: Agent,
  reasons: Schema.NonEmptyArray(AgentReason),
  since: Schema.DateTimeUtcFromString,
})

export type AgentNeedsYou = typeof AgentNeedsYou.Type

export const PullRequestNeedsYou = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestSummary,
  reasons: Schema.NonEmptyArray(PullRequestReason),
  since: Schema.DateTimeUtcFromString,
})

export type PullRequestNeedsYou = typeof PullRequestNeedsYou.Type

export const OutsideQuestion = Schema.TaggedStruct("OutsideQuestion", {
  id: Schema.String,
  question: Schema.String,
  choices: Schema.Array(Schema.String),
  askedBy: Schema.String,
  since: Schema.DateTimeUtcFromString,
})

export type OutsideQuestion = typeof OutsideQuestion.Type

export const GlobalConversationNeedsYou = Schema.TaggedStruct("GlobalConversation", {
  requests: WaitingRequestParts,
  since: Schema.DateTimeUtcFromString,
})

export type GlobalConversationNeedsYou = typeof GlobalConversationNeedsYou.Type

export const OutsideChoice = Schema.TaggedStruct("Choice", {
  choice: Schema.String,
})

export const OutsideText = Schema.TaggedStruct("Text", {
  text: Schema.Trimmed.check(Schema.isNonEmpty()),
})

export const OutsideQuestionAnswer = Schema.Union([OutsideChoice, OutsideText])

export type OutsideQuestionAnswer = typeof OutsideQuestionAnswer.Type

export class OutsideQuestionNotWaiting extends Schema.TaggedError<OutsideQuestionNotWaiting>()(
  "OutsideQuestionNotWaiting",
  {},
) {}

export const AskUserAnswered = Schema.TaggedStruct("Answered", {
  answer: Schema.String,
  by: Schema.Literals(["choice", "text"]),
})

export const AskUserTimedOut = Schema.TaggedStruct("TimedOut", {})

export const AskUserCancelled = Schema.TaggedStruct("Cancelled", {})

export const AskUserResult = Schema.Union([AskUserAnswered, AskUserTimedOut, AskUserCancelled])

export type AskUserResult = typeof AskUserResult.Type

export const NeedsYouItem = Schema.Union([
  AgentNeedsYou,
  PullRequestNeedsYou,
  OutsideQuestion,
  GlobalConversationNeedsYou,
])

export type NeedsYouItem = typeof NeedsYouItem.Type

export const NeedsYou = Schema.Array(NeedsYouItem)

export const needsYouGroups = ["stopped", "reviews", "mine", "finished"] as const

export type NeedsYouGroup = (typeof needsYouGroups)[number]

export const needsYouGroupOf = (item: NeedsYouItem): NeedsYouGroup =>
  Match.valueTags(item, {
    OutsideQuestion: () => "stopped" as const,
    GlobalConversation: () => "stopped" as const,
    Agent: ({ reasons }) =>
      reasons.some(Predicate.isTagged("WaitingRequests"))
        ? ("stopped" as const)
        : ("finished" as const),
    PullRequest: ({ reasons }) =>
      reasons.some(Predicate.isTagged("AgentReviewFinished"))
        ? ("reviews" as const)
        : ("mine" as const),
  })

export type NeedsYou = typeof NeedsYou.Type

import { Schema } from "effect"
import { Agent, PermissionRequestPart, QuestionPart } from "./agent"
import { PullRequestSummary } from "./pullRequestList"

export const WaitingRequests = Schema.TaggedStruct("WaitingRequests", {
  requests: Schema.NonEmptyArray(Schema.Union([PermissionRequestPart, QuestionPart])),
})

export const AgentReason = Schema.Union([WaitingRequests])

export type AgentReason = typeof AgentReason.Type

export const AgentReviewFinished = Schema.TaggedStruct("AgentReviewFinished", {})

export const PullRequestReason = Schema.Union([AgentReviewFinished])

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
  /** The finished Agent review's writtenAt, which also names that review when marking it done. */
  since: Schema.DateTimeUtcFromString,
})

export type PullRequestNeedsYou = typeof PullRequestNeedsYou.Type

/** One question from an agent outside Glass. It is one Needs you row until the user answers, or the wait ends. */
export const OutsideQuestion = Schema.TaggedStruct("OutsideQuestion", {
  id: Schema.String,
  question: Schema.String,
  choices: Schema.Array(Schema.String),
  /** The name the user approved the outside agent under, such as Claude Code. */
  askedBy: Schema.String,
  since: Schema.DateTimeUtcFromString,
})

export type OutsideQuestion = typeof OutsideQuestion.Type

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

export const NeedsYouItem = Schema.Union([AgentNeedsYou, PullRequestNeedsYou, OutsideQuestion])

export type NeedsYouItem = typeof NeedsYouItem.Type

export const NeedsYou = Schema.Array(NeedsYouItem)

export type NeedsYou = typeof NeedsYou.Type

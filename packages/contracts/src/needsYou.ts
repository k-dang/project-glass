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

export const NeedsYouItem = Schema.Union([AgentNeedsYou, PullRequestNeedsYou])

export type NeedsYouItem = typeof NeedsYouItem.Type

export const NeedsYou = Schema.Array(NeedsYouItem)

export type NeedsYou = typeof NeedsYou.Type

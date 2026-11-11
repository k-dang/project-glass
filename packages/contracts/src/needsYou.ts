import { Schema } from "effect"
import { Agent, PermissionRequestPart, QuestionPart } from "./agent"
import { PullRequestSummary } from "./pullRequestList"

/** An Agent's Permission requests and Questions still waiting, in transcript order. Each one is answered with `AnswerRequest`. */
export const WaitingRequests = Schema.TaggedStruct("WaitingRequests", {
  requests: Schema.NonEmptyArray(Schema.Union([PermissionRequestPart, QuestionPart])),
})

/** Why an Agent needs the user. A new kind of Agent reason is a new member here. */
export const AgentReason = Schema.Union([WaitingRequests])

export type AgentReason = typeof AgentReason.Type

/** GitHub has an outstanding Review request to the user or one of their teams, on a PR by someone else that isn't a draft. */
export const ReviewRequested = Schema.TaggedStruct("ReviewRequested", {})

/** The PR is in the Queue and its Agent review is finished. */
export const AgentReviewFinished = Schema.TaggedStruct("AgentReviewFinished", {})

/** Why a PR needs the user. A new kind of PR reason is a new member here. */
export const PullRequestReason = Schema.Union([ReviewRequested, AgentReviewFinished])

export type PullRequestReason = typeof PullRequestReason.Type

export const AgentNeedsYou = Schema.TaggedStruct("Agent", {
  agent: Agent,
  reasons: Schema.NonEmptyArray(AgentReason),
  /** When the earliest of its reasons still waiting started. */
  since: Schema.DateTimeUtcFromString,
})

export type AgentNeedsYou = typeof AgentNeedsYou.Type

export const PullRequestNeedsYou = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestSummary,
  reasons: Schema.NonEmptyArray(PullRequestReason),
  /** When the earliest of its reasons still waiting started. */
  since: Schema.DateTimeUtcFromString,
})

export type PullRequestNeedsYou = typeof PullRequestNeedsYou.Type

/** One subject waiting on the user, with every reason it is waiting. A subject appears at most once. */
export const NeedsYouItem = Schema.Union([AgentNeedsYou, PullRequestNeedsYou])

export type NeedsYouItem = typeof NeedsYouItem.Type

/** Needs you: Agents first, then the longest waiting first. */
export const NeedsYou = Schema.Array(NeedsYouItem)

export type NeedsYou = typeof NeedsYou.Type

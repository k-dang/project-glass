import { Schema } from "effect"
import { Revision } from "./revision"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./discussion"
import { AgentRunnerIdentity } from "./engine"

export const FollowUpMessage = Schema.Trimmed.check(Schema.isNonEmpty())

/** A Draft the agent proposed in a Follow-up, on a line of the Agent review's diff. */
export const SuggestedDraft = Schema.Struct({
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.String,
})

export type SuggestedDraft = typeof SuggestedDraft.Type

export const FollowUp = Schema.Struct({
  message: FollowUpMessage,
  /** The agent's Markdown answer. */
  answer: Schema.String,
  suggestedDrafts: Schema.Array(SuggestedDraft),
})

export type FollowUp = typeof FollowUp.Type

export const AgentReview = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  /** The agent's whole review, opening with a bold sentence naming the PR's main risk. */
  markdown: Schema.String,
  /** Oldest first. Writing the Agent review again starts without them. */
  followUps: Schema.Array(FollowUp),
})

export type AgentReview = typeof AgentReview.Type

export const ReviewPrompt = Schema.Trimmed.check(Schema.isNonEmpty())

export const defaultReviewPrompt = "Perform a code review."

export class AgentReviewFailure extends Schema.TaggedError<AgentReviewFailure>()(
  "AgentReviewFailure",
  {
    reason: CheckoutRunReason,
    message: Schema.String,
    runner: Schema.NullOr(AgentRunnerIdentity),
  },
) {}

export const AgentReviewState = Schema.Struct({
  review: Schema.NullOr(AgentReview),
  job: Schema.Union([
    Schema.Struct({ status: Schema.Literal("idle") }),
    Schema.Struct({
      status: Schema.Literal("reviewing"),
      startedAt: Schema.Number,
      runner: Schema.NullOr(AgentRunnerIdentity),
    }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: AgentReviewFailure }),
    Schema.Struct({
      status: Schema.Literal("following-up"),
      message: FollowUpMessage,
      startedAt: Schema.Number,
      runner: Schema.NullOr(AgentRunnerIdentity),
    }),
    /** Keeps the message so the user can send it again. */
    Schema.Struct({
      status: Schema.Literal("follow-up-failed"),
      message: FollowUpMessage,
      reason: AgentReviewFailure,
    }),
  ]),
})

export type AgentReviewState = typeof AgentReviewState.Type

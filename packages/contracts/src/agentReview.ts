import { Schema } from "effect"
import { Revision } from "./revision"
import { CheckoutRunReason } from "./checkoutRun"
import { AgentRunnerIdentity } from "./engine"

export const AgentReview = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  /** The agent's whole review, opening with a bold sentence naming the PR's main risk. */
  markdown: Schema.String,
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
  ]),
})

export type AgentReviewState = typeof AgentReviewState.Type

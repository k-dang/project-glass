import { Option, Schema } from "effect"
import type { ToolCallPart } from "./agent"
import { Revision } from "./revision"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./discussion"
import { AgentRunnerIdentity } from "./engine"

export const FollowUpMessage = Schema.Trimmed.check(Schema.isNonEmpty())

export const SuggestedDraft = Schema.Struct({
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.String,
})

export type SuggestedDraft = typeof SuggestedDraft.Type

export const SUGGEST_DRAFT_TOOL = "suggest_draft"

const decodeSuggestedDraft = Schema.decodeUnknownOption(Schema.fromJsonString(SuggestedDraft))

export const acceptedSuggestedDraftOf = (call: typeof ToolCallPart.Type): SuggestedDraft | null =>
  call.name === SUGGEST_DRAFT_TOOL && call.status === "done"
    ? Option.getOrNull(decodeSuggestedDraft(call.input))
    : null

export const AgentReview = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  markdown: Schema.String,
  agentId: Schema.NullOr(Schema.String),
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
    Schema.Struct({ status: Schema.Literal("waiting") }),
    Schema.Struct({
      status: Schema.Literal("reviewing"),
      startedAt: Schema.Number,
      runner: Schema.NullOr(AgentRunnerIdentity),
    }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: AgentReviewFailure }),
    Schema.Struct({
      status: Schema.Literal("starting-agent"),
      message: FollowUpMessage,
      startedAt: Schema.Number,
      runner: AgentRunnerIdentity,
    }),
    Schema.Struct({
      status: Schema.Literal("agent-start-failed"),
      message: FollowUpMessage,
      reason: AgentReviewFailure,
    }),
  ]),
})

export type AgentReviewState = typeof AgentReviewState.Type

/** Whether a written Agent review counts as finished while its job is in each status. A Follow-up starting on it leaves it finished. */
const finishedWhile: Record<AgentReviewState["job"]["status"], boolean> = {
  idle: true,
  "starting-agent": true,
  "agent-start-failed": true,
  waiting: false,
  reviewing: false,
  failed: false,
}

/** The PR's finished Agent review, or null when none is written or a newer one is waiting, running, or failed. */
export const finishedReview = (state: AgentReviewState): AgentReview | null =>
  state.review !== null && finishedWhile[state.job.status] ? state.review : null

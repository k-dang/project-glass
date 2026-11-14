import { Option, Schema } from "effect"
import type { ToolCallPart } from "./agent"
import { Revision } from "./revision"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./discussion"
import { AgentRunnerIdentity } from "./engine"
import { TourCodeTarget } from "./tour"
import { PullRequestRef } from "./pullRequest"

export const AgentReviewDone = Schema.Struct({
  pullRequest: PullRequestRef,
  writtenAt: Schema.DateTimeUtcFromString,
})

export type AgentReviewDone = typeof AgentReviewDone.Type

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

export const RiskKind = Schema.Literals([
  "data-access",
  "migration",
  "auth",
  "concurrency",
  "public-contract",
])

export type RiskKind = typeof RiskKind.Type

export const Hotspot = Schema.Struct({
  title: Schema.String,
  kind: RiskKind,
  place: Schema.NullOr(TourCodeTarget),
  why: Schema.String,
  evidence: Schema.String,
  check: Schema.String,
})

export type Hotspot = typeof Hotspot.Type

export const LowAttentionFile = Schema.Struct({ path: Schema.String, reason: Schema.String })

export type LowAttentionFile = typeof LowAttentionFile.Type

export const AgentReview = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  markdown: Schema.String,
  hotspots: Schema.Array(Hotspot),
  lowAttention: Schema.Array(LowAttentionFile),
  agentId: Schema.NullOr(Schema.String),
  done: Schema.Boolean,
  reported: Schema.Boolean,
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

const finishedWhile: Record<AgentReviewState["job"]["status"], boolean> = {
  idle: true,
  "starting-agent": true,
  "agent-start-failed": true,
  waiting: false,
  reviewing: false,
  failed: false,
}

export const splitLead = (markdown: string) => {
  const end = /\n\s*\n/.exec(markdown)

  return end === null
    ? { lead: markdown, rest: "" }
    : { lead: markdown.slice(0, end.index), rest: markdown.slice(end.index + end[0].length) }
}

export const finishedReview = (state: AgentReviewState): AgentReview | null =>
  state.review !== null && finishedWhile[state.job.status] ? state.review : null

import { Schema } from "effect"
import { acceptedCallInput } from "./thread"
import { Revision } from "./revision"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./comment"
import { AgentRunnerIdentity } from "./engine"
import { TourCodeTarget } from "./tour"
import { PullRequestRef } from "./pullRequest"

export const AgentReviewDone = Schema.Struct({
  pullRequest: PullRequestRef,
  writtenAt: Schema.DateTimeUtcFromString,
})

export type AgentReviewDone = typeof AgentReviewDone.Type

export const SuggestedDraft = Schema.Struct({
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
  body: Schema.Trim.check(Schema.isNonEmpty()),
})

export type SuggestedDraft = typeof SuggestedDraft.Type

export const SUGGEST_DRAFT_TOOL = "suggest_draft"

export const acceptedSuggestedDraftOf = acceptedCallInput(SUGGEST_DRAFT_TOOL, SuggestedDraft)

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
  threadId: Schema.String,
  done: Schema.Boolean,
  includedInStartedWorkUpdate: Schema.Boolean,
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
  ]),
})

export type AgentReviewState = typeof AgentReviewState.Type

const finishedWhile: Record<AgentReviewState["job"]["status"], boolean> = {
  idle: true,
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

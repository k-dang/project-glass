import { Option, Schema } from "effect"
import type { ToolCallPart } from "./agent"
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

/** Names one side of a changed file, to look up the lines of the diff there. */
export const diffLinesKey = (side: DiffSide, path: string) => `${side}:${path}`

/** The tool an Agent review's Agent calls to propose a Suggested draft. */
export const SUGGEST_DRAFT_TOOL = "suggest_draft"

/** Claude Code names a tool from Glass's MCP server after the server. */
const suggestDraftToolNames = new Set([SUGGEST_DRAFT_TOOL, `mcp__glass__${SUGGEST_DRAFT_TOOL}`])

const decodeSuggestedDraft = Schema.decodeUnknownOption(Schema.fromJsonString(SuggestedDraft))

/** The Suggested draft a tool call proposed, once Glass accepted its place on the diff. */
export const suggestedDraftOf = (call: typeof ToolCallPart.Type): SuggestedDraft | null =>
  suggestDraftToolNames.has(call.name) && call.status === "done"
    ? Option.getOrNull(decodeSuggestedDraft(call.input))
    : null

export const AgentReview = Schema.Struct({
  revision: Revision,
  writtenAt: Schema.DateTimeUtcFromString,
  /** The agent's whole review, opening with a bold sentence naming the PR's main risk. */
  markdown: Schema.String,
  /**
   * The Agent whose Turns are the Follow-ups, `null` until the first. Writing the Agent review again
   * removes it.
   */
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
    Schema.Struct({
      status: Schema.Literal("reviewing"),
      startedAt: Schema.Number,
      runner: Schema.NullOr(AgentRunnerIdentity),
    }),
    Schema.Struct({ status: Schema.Literal("failed"), reason: AgentReviewFailure }),
    /** Glass is starting the Agent for the first Follow-up, which becomes its first Turn. */
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

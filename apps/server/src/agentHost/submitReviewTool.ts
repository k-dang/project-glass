import { acceptedCallInput, Hotspot, LowAttentionFile } from "@glass/contracts"
import { Schema } from "effect"
import { replyTo, toolParameters } from "./hostTool"

export const SUBMIT_REVIEW_TOOL = "submit_review"

export const AgentReviewAnswer = Schema.Struct({
  markdown: Schema.Trim.check(Schema.isNonEmpty()),
  hotspots: Schema.Array(Hotspot),
  lowAttention: Schema.Array(LowAttentionFile),
})

export type AgentReviewAnswer = typeof AgentReviewAnswer.Type

export const submitReviewDescription =
  "Hand in your Agent review. Glass refuses one that doesn't fit, saying why, so you can fix it and call again."

export const submitReviewParameters = toolParameters({
  markdown: [AgentReviewAnswer.fields.markdown, "The review in Markdown."],
  hotspots: [AgentReviewAnswer.fields.hotspots, "The hotspots, most important first."],
  lowAttention: [
    AgentReviewAnswer.fields.lowAttention,
    "The changed files that need little attention.",
  ],
})

const SUBMITTED = "Glass has your Agent review. End your Turn now."

export const submitReview = replyTo(AgentReviewAnswer, () => ({ accepted: true, text: SUBMITTED }))

export const acceptedReviewOf = acceptedCallInput(SUBMIT_REVIEW_TOOL, AgentReviewAnswer)

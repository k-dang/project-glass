import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { StaleRevision } from "./revision"

export const ReviewDecision = Schema.Literals(["comment", "approve", "request-changes"])

export type ReviewDecision = typeof ReviewDecision.Type

export const ReviewState = Schema.Literals([...ReviewDecision.literals, "dismissed"])

export type ReviewState = typeof ReviewState.Type

export class Review extends Schema.TaggedClass<Review>()("Review", {
  id: Schema.String,
  author: Schema.String,
  state: ReviewState,
  bodyHtml: Schema.String,
  submittedAt: Schema.DateTimeUtcFromString,
}) {}

export class ReviewRejected extends Schema.TaggedError<ReviewRejected>()("ReviewRejected", {
  message: Schema.String,
}) {}

export const SubmitReviewError = Schema.Union([StaleRevision, ReviewRejected, ConnectionError])

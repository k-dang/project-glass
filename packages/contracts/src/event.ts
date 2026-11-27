import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"

export class EventLogError extends Schema.TaggedError<EventLogError>()("EventLogError", {
  message: Schema.String,
}) {}

export const EventSource = Schema.Literals(["github"])

export type EventSource = typeof EventSource.Type

export const FailingCheck = Schema.Struct({
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
})

export type FailingCheck = typeof FailingCheck.Type

export const ReviewThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
})

export const WaitingReviewThread = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  comments: Schema.NonEmptyArray(ReviewThreadComment),
})

export type WaitingReviewThread = typeof WaitingReviewThread.Type

export const ChecksFailedEvent = Schema.TaggedStruct("ChecksFailed", {
  pullRequest: PullRequestRef,
  head: Schema.String,
  checks: Schema.NonEmptyArray(FailingCheck),
})

export const ChecksPassedEvent = Schema.TaggedStruct("ChecksPassed", {
  pullRequest: PullRequestRef,
  head: Schema.String,
})

export const ReviewFeedbackEvent = Schema.TaggedStruct("ReviewFeedback", {
  pullRequest: PullRequestRef,
  reviewThreads: Schema.NonEmptyArray(WaitingReviewThread),
})

export const ChangesRequestedEvent = Schema.TaggedStruct("ChangesRequested", {
  pullRequest: PullRequestRef,
  reviewers: Schema.NonEmptyArray(Schema.String),
})

export const MergeConflictEvent = Schema.TaggedStruct("MergeConflict", {
  pullRequest: PullRequestRef,
  base: Schema.String,
})

export const MergeConflictClearedEvent = Schema.TaggedStruct("MergeConflictCleared", {
  pullRequest: PullRequestRef,
})

export const PullRequestMergedEvent = Schema.TaggedStruct("PullRequestMerged", {
  pullRequest: PullRequestRef,
  mergedAt: Schema.DateTimeUtcFromString,
})

export const PullRequestClosedEvent = Schema.TaggedStruct("PullRequestClosed", {
  pullRequest: PullRequestRef,
  closedAt: Schema.DateTimeUtcFromString,
})

export const Event = Schema.Union([
  ChecksFailedEvent,
  ChecksPassedEvent,
  ReviewFeedbackEvent,
  ChangesRequestedEvent,
  MergeConflictEvent,
  MergeConflictClearedEvent,
  PullRequestMergedEvent,
  PullRequestClosedEvent,
])

export type Event = typeof Event.Type

export type EventKind = Event["_tag"]

export const EventKind = Schema.Literals([
  "ChecksFailed",
  "ChecksPassed",
  "ReviewFeedback",
  "ChangesRequested",
  "MergeConflict",
  "MergeConflictCleared",
  "PullRequestMerged",
  "PullRequestClosed",
] satisfies ReadonlyArray<EventKind>)

export const eventKindWords: Record<EventKind, string> = {
  ChecksFailed: "failing checks",
  ChecksPassed: "passing checks",
  ReviewFeedback: "review feedback",
  ChangesRequested: "changes requested",
  MergeConflict: "a merge conflict",
  MergeConflictCleared: "a merge conflict cleared",
  PullRequestMerged: "merged",
  PullRequestClosed: "closed",
}

export const finalEventKinds: ReadonlySet<EventKind> = new Set([
  "PullRequestMerged",
  "PullRequestClosed",
])

export class LoggedEvent extends Schema.Class<LoggedEvent>("LoggedEvent")({
  id: Schema.Int,
  source: EventSource,
  occurredAt: Schema.DateTimeUtcFromString,
  event: Event,
}) {}

export class EventPage extends Schema.Class<EventPage>("EventPage")({
  events: Schema.Array(LoggedEvent),
  hasMore: Schema.Boolean,
}) {}

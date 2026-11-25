import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"

export class EventLogError extends Schema.TaggedError<EventLogError>()("EventLogError", {
  message: Schema.String,
}) {}

export const EventSource = Schema.Literals(["github"])

export type EventSource = typeof EventSource.Type

export const ChecksFailedEvent = Schema.TaggedStruct("ChecksFailed", {
  pullRequest: PullRequestRef,
  head: Schema.String,
})

export const ChecksPassedEvent = Schema.TaggedStruct("ChecksPassed", {
  pullRequest: PullRequestRef,
  head: Schema.String,
})

export const ReviewFeedbackWaitingEvent = Schema.TaggedStruct("ReviewFeedbackWaiting", {
  pullRequest: PullRequestRef,
  reviewThreads: Schema.Int,
})

export const ChangesRequestedEvent = Schema.TaggedStruct("ChangesRequested", {
  pullRequest: PullRequestRef,
})

export const MergeConflictAppearedEvent = Schema.TaggedStruct("MergeConflictAppeared", {
  pullRequest: PullRequestRef,
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
  ReviewFeedbackWaitingEvent,
  ChangesRequestedEvent,
  MergeConflictAppearedEvent,
  MergeConflictClearedEvent,
  PullRequestMergedEvent,
  PullRequestClosedEvent,
])

export type Event = typeof Event.Type

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

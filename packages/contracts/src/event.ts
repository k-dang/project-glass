import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"

export class EventLogError extends Schema.TaggedError<EventLogError>()("EventLogError", {
  message: Schema.String,
}) {}

export const EventSource = Schema.Literals(["github", "glass"])

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

const endedTurn = {
  threadId: Schema.String,
  name: Schema.String,
  endedAt: Schema.DateTimeUtcFromString,
}

export const ThreadFinishedEvent = Schema.TaggedStruct("ThreadFinished", endedTurn)

export const ThreadFailedEvent = Schema.TaggedStruct("ThreadFailed", {
  ...endedTurn,
  reason: Schema.String,
})

export const ThreadWaitingEvent = Schema.TaggedStruct("ThreadWaiting", {
  threadId: Schema.String,
  name: Schema.String,
  requestId: Schema.String,
})

export const AgentReviewFinishedEvent = Schema.TaggedStruct("AgentReviewFinished", {
  pullRequest: PullRequestRef,
  writtenAt: Schema.DateTimeUtcFromString,
})

export const AgentReviewFailedEvent = Schema.TaggedStruct("AgentReviewFailed", {
  pullRequest: PullRequestRef,
  reason: Schema.String,
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
  ThreadFinishedEvent,
  ThreadFailedEvent,
  ThreadWaitingEvent,
  AgentReviewFinishedEvent,
  AgentReviewFailedEvent,
])

export type Event = typeof Event.Type

export type EventKind = Event["_tag"]

export type PullRequestEvent = Extract<Event, { readonly _tag: typeof PullRequestEventKind.Type }>

export const PullRequestEventKind = Schema.Literals([
  "ChecksFailed",
  "ChecksPassed",
  "ReviewFeedback",
  "ChangesRequested",
  "MergeConflict",
  "MergeConflictCleared",
  "PullRequestMerged",
  "PullRequestClosed",
] satisfies ReadonlyArray<EventKind>)

export const threadEventKinds = [
  "ThreadFinished",
  "ThreadFailed",
  "ThreadWaiting",
] as const satisfies ReadonlyArray<EventKind>

export const agentReviewEventKinds = [
  "AgentReviewFinished",
  "AgentReviewFailed",
] as const satisfies ReadonlyArray<EventKind>

export const EventKind = Schema.Literals([
  ...PullRequestEventKind.literals,
  ...threadEventKinds,
  ...agentReviewEventKinds,
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
  ThreadFinished: "finished",
  ThreadFailed: "failed",
  ThreadWaiting: "waiting on the user",
  AgentReviewFinished: "written",
  AgentReviewFailed: "failed",
}

export const finalEventKinds: ReadonlySet<EventKind> = new Set([
  "PullRequestMerged",
  "PullRequestClosed",
  ...agentReviewEventKinds,
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

import { Match, Schema } from "effect"
import {
  agentReviewEventKinds,
  EventKind,
  EventSource,
  type PullRequestEventKind,
  threadEventKinds,
} from "./event"
import { PullRequestRef, referenceKey } from "./pullRequest"

export const defaultSubscriptionKinds: ReadonlyArray<typeof PullRequestEventKind.Type> = [
  "ChecksFailed",
  "ReviewFeedback",
  "ChangesRequested",
  "MergeConflict",
]

export const PullRequestSubject = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestRef,
})

export const ThreadSubject = Schema.TaggedStruct("Thread", { threadId: Schema.String })

export const AgentReviewSubject = Schema.TaggedStruct("AgentReview", {
  pullRequest: PullRequestRef,
})

export const StartedWorkSubject = Schema.Union([ThreadSubject, AgentReviewSubject])

export type StartedWorkSubject = typeof StartedWorkSubject.Type

export const SubscriptionSubject = Schema.Union([
  PullRequestSubject,
  ThreadSubject,
  AgentReviewSubject,
])

export type SubscriptionSubject = typeof SubscriptionSubject.Type

export const subjectSource = (subject: SubscriptionSubject): EventSource =>
  Match.valueTags(subject, {
    PullRequest: () => "github" as const,
    Thread: () => "glass" as const,
    AgentReview: () => "glass" as const,
  })

export const subjectKey = (subject: SubscriptionSubject) =>
  Match.valueTags(subject, {
    PullRequest: ({ pullRequest }) => referenceKey(pullRequest),
    Thread: ({ threadId }) => threadId,
    AgentReview: ({ pullRequest }) => referenceKey(pullRequest),
  })

export const startedWorkKinds = (subject: StartedWorkSubject): ReadonlyArray<EventKind> =>
  Match.valueTags(subject, {
    Thread: () => threadEventKinds,
    AgentReview: () => agentReviewEventKinds,
  })

export class Subscription extends Schema.Class<Subscription>("Subscription")({
  id: Schema.String,
  subscriber: Schema.String.annotate({ description: "The Thread or the Global chat it tells." }),
  source: EventSource,
  subject: SubscriptionSubject.annotate({ description: "What it is about." }),
  kinds: Schema.Array(EventKind),
  note: Schema.String,
}) {}

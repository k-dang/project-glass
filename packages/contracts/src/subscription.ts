import { Match, Schema } from "effect"
import { EventKind, EventSource } from "./event"
import { PullRequestRef, referenceKey } from "./pullRequest"

export const defaultSubscriptionKinds: ReadonlyArray<EventKind> = [
  "ChecksFailed",
  "ReviewFeedback",
  "ChangesRequested",
  "MergeConflict",
]

export const PullRequestSubject = Schema.TaggedStruct("PullRequest", {
  pullRequest: PullRequestRef,
})

export const SubscriptionSubject = Schema.Union([PullRequestSubject])

export type SubscriptionSubject = typeof SubscriptionSubject.Type

export const subjectSource = (subject: SubscriptionSubject): EventSource =>
  Match.valueTags(subject, { PullRequest: () => "github" as const })

export const subjectKey = ({ pullRequest }: SubscriptionSubject) => referenceKey(pullRequest)

export class Subscription extends Schema.Class<Subscription>("Subscription")({
  id: Schema.String,
  threadId: Schema.String,
  source: EventSource,
  subject: SubscriptionSubject.annotate({ description: "What it is about." }),
  kinds: Schema.Array(EventKind),
  note: Schema.String,
}) {}

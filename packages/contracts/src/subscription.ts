import { Schema } from "effect"
import { EventSource } from "./event"
import { PullRequestRef } from "./pullRequest"

export const openReasons = [
  "failing-checks",
  "review-feedback",
  "changes-requested",
  "merge-conflict",
] as const

export type OpenReason = (typeof openReasons)[number]

export const SubscriptionReason = Schema.Literals([...openReasons, "merged-or-closed"])

export type SubscriptionReason = typeof SubscriptionReason.Type

export const defaultSubscriptionReasons: ReadonlyArray<SubscriptionReason> = openReasons

export const subscriptionReasonWords: Record<SubscriptionReason, string> = {
  "failing-checks": "failing checks",
  "review-feedback": "review feedback",
  "changes-requested": "changes requested",
  "merge-conflict": "a merge conflict",
  "merged-or-closed": "merged or closed",
}

export const PullRequestSubject = Schema.TaggedStruct("PullRequest", {
  pullRequest: Schema.NullOr(PullRequestRef).annotate({
    description:
      "The PR, or null for the Thread's own PR: the one for the branch its folder has checked out, which may not exist yet.",
  }),
})

export const SubscriptionSubject = Schema.Union([PullRequestSubject])

export type SubscriptionSubject = typeof SubscriptionSubject.Type

export const PullRequestEnding = Schema.TaggedStruct("PullRequest", {
  state: Schema.Literals(["merged", "closed"]),
  pullRequest: PullRequestRef,
})

export type PullRequestEnding = typeof PullRequestEnding.Type

export const SubscriptionEnding = Schema.Union([PullRequestEnding])

export type SubscriptionEnding = typeof SubscriptionEnding.Type

export class Subscription extends Schema.Class<Subscription>("Subscription")({
  id: Schema.String,
  threadId: Schema.String,
  source: EventSource,
  subject: SubscriptionSubject.annotate({ description: "What it is about." }),
  reasons: Schema.Array(SubscriptionReason),
  note: Schema.String,
}) {}

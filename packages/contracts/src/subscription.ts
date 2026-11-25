import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"

export const SubscriptionReason = Schema.Literals([
  "failing-checks",
  "review-feedback",
  "changes-requested",
  "merge-conflict",
  "merged-or-closed",
])

export type SubscriptionReason = typeof SubscriptionReason.Type

export const defaultSubscriptionReasons: ReadonlyArray<SubscriptionReason> = [
  "failing-checks",
  "review-feedback",
  "changes-requested",
  "merge-conflict",
]

export class Subscription extends Schema.Class<Subscription>("Subscription")({
  id: Schema.String,
  threadId: Schema.String,
  source: Schema.Literal("github"),
  pullRequest: Schema.NullOr(PullRequestRef).annotate({
    description:
      "The PR it is about, or null for the Thread's own PR: the one for the branch its folder has checked out, which may not exist yet.",
  }),
  reasons: Schema.Array(SubscriptionReason),
  note: Schema.String,
}) {}

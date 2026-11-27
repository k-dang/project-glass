import { Schema } from "effect"
import { LoggedEvent } from "./event"
import { SubscriptionSubject } from "./subscription"

export const UpdatedSubscription = Schema.Struct({
  subscriptionId: Schema.String,
  subject: SubscriptionSubject,
  note: Schema.String,
  events: Schema.NonEmptyArray(LoggedEvent),
})

export type UpdatedSubscription = typeof UpdatedSubscription.Type

export const Update = Schema.TaggedStruct("Update", {
  subscriptions: Schema.NonEmptyArray(UpdatedSubscription),
  note: Schema.String,
})

export type Update = typeof Update.Type

export const PullRequestUpdateNote = Schema.Trimmed.check(Schema.isNonEmpty())

export const defaultPullRequestUpdateNote = [
  "Fix the failing checks.",
  "Address the review feedback, then reply to and resolve each Review thread you handled.",
  "Rebase when the PR has a merge conflict.",
  "Change only this Thread's own PR unless the user asked otherwise.",
  "Never merge a PR.",
].join("\n")

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
})

export type Update = typeof Update.Type

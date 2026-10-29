import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"
import { Revision } from "./revision"

export const ReviewPosition = Schema.Union([
  Schema.Struct({ tab: Schema.Literal("overview") }),
  Schema.Struct({
    tab: Schema.Literal("changes"),
    file: Schema.NullOr(Schema.NonEmptyString),
    order: Schema.Literals(["path", "tour"]),
  }),
  Schema.Struct({ tab: Schema.Literal("files"), file: Schema.NullOr(Schema.NonEmptyString) }),
])

export type ReviewPosition = typeof ReviewPosition.Type

export const ReviewDestination = Schema.Struct({
  area: Schema.Literal("reviews"),
  login: Schema.NonEmptyString,
  pullRequest: PullRequestRef,
  revision: Revision,
  position: ReviewPosition,
})

export type ReviewDestination = typeof ReviewDestination.Type

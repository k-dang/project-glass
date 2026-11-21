import { Schema } from "effect"
import { Thread } from "./thread"
import { ReviewDestination } from "./reviewDestination"

export const ThreadDestination = Schema.Struct({
  area: Schema.Literal("threads"),
  threadId: Thread.fields.id,
})

export type ThreadDestination = typeof ThreadDestination.Type

export const ResumableDestination = Schema.Union([ReviewDestination, ThreadDestination])

export type ResumableDestination = typeof ResumableDestination.Type

export class SavedPlace extends Schema.Class<SavedPlace>("SavedPlace")({
  destination: ResumableDestination,
  savedAt: Schema.DateTimeUtcFromString,
}) {}

export class SavedPlaceError extends Schema.TaggedError<SavedPlaceError>()("SavedPlaceError", {
  message: Schema.String,
}) {}

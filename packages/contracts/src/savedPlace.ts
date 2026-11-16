import { Schema } from "effect"
import { Conversation } from "./conversation"
import { ReviewDestination } from "./reviewDestination"

export const ConversationDestination = Schema.Struct({
  area: Schema.Literal("conversations"),
  conversationId: Conversation.fields.id,
})

export type ConversationDestination = typeof ConversationDestination.Type

export const ResumableDestination = Schema.Union([ReviewDestination, ConversationDestination])

export type ResumableDestination = typeof ResumableDestination.Type

export class SavedPlace extends Schema.Class<SavedPlace>("SavedPlace")({
  destination: ResumableDestination,
  savedAt: Schema.DateTimeUtcFromString,
}) {}

export class SavedPlaceError extends Schema.TaggedError<SavedPlaceError>()("SavedPlaceError", {
  message: Schema.String,
}) {}

import { Schema } from "effect"
import { Agent } from "./agent"
import { ReviewDestination } from "./reviewDestination"

export const AgentDestination = Schema.Struct({
  area: Schema.Literal("agents"),
  agentId: Agent.fields.id,
})

export type AgentDestination = typeof AgentDestination.Type

export const ResumableDestination = Schema.Union([ReviewDestination, AgentDestination])

export type ResumableDestination = typeof ResumableDestination.Type

export class SavedPlace extends Schema.Class<SavedPlace>("SavedPlace")({
  destination: ResumableDestination,
  savedAt: Schema.DateTimeUtcFromString,
}) {}

export class SavedPlaceError extends Schema.TaggedError<SavedPlaceError>()("SavedPlaceError", {
  message: Schema.String,
}) {}

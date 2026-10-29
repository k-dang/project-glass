import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { DiffSide, OriginalLine } from "./discussion"
import { StaleRevision } from "./revision"

export const LinePlace = Schema.TaggedStruct("LinePlace", {
  side: DiffSide,
  line: Schema.Int,
})

export const FlaggedPlace = Schema.TaggedStruct("FlaggedPlace", {
  originalLine: OriginalLine,
  diffHunk: Schema.String,
})

export const DraftPlace = Schema.Union([LinePlace, FlaggedPlace])

export type DraftPlace = typeof DraftPlace.Type

export class Draft extends Schema.Class<Draft>("Draft")({
  id: Schema.String,
  path: Schema.String,
  place: DraftPlace,
  body: Schema.String,
}) {}

export class DraftNotFound extends Schema.TaggedError<DraftNotFound>()("DraftNotFound", {
  id: Schema.String,
}) {}

export const CreateDraftError = Schema.Union([StaleRevision, ConnectionError])

export const UpdateDraftError = Schema.Union([DraftNotFound, ConnectionError])

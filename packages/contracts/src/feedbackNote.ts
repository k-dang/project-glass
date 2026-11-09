import { Schema } from "effect"
import { DiffSide } from "./discussion"

const LineNumber = Schema.Int.check(Schema.isGreaterThan(0))

export class FeedbackNote extends Schema.Class<FeedbackNote>("FeedbackNote")({
  id: Schema.String,
  path: Schema.String,
  side: DiffSide,
  start: LineNumber,
  end: LineNumber,
  code: Schema.String,
  changesId: Schema.String,
  text: Schema.Trimmed.check(Schema.isNonEmpty()),
}) {}

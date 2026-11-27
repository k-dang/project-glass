import { Effect, Schema } from "effect"
import { DiffSide } from "./comment"

const LineNumber = Schema.Int.check(Schema.isGreaterThan(0))

const NoteText = Schema.Trimmed.check(Schema.isNonEmpty())

export class LineNote extends Schema.Class<LineNote>("LineNote")({
  _tag: Schema.tag("LineNote").pipe(Schema.withDecodingDefaultKey(Effect.succeed("LineNote"))),
  id: Schema.String,
  path: Schema.String,
  side: DiffSide,
  start: LineNumber,
  end: LineNumber,
  code: Schema.String,
  changesId: Schema.String,
  text: NoteText,
}) {}

export const PageText = Schema.TaggedStruct("PageText", {
  selector: Schema.String,
  heading: Schema.NullOr(Schema.String),
  excerpt: Schema.String,
})

export const PageElement = Schema.TaggedStruct("PageElement", {
  selector: Schema.String,
  heading: Schema.NullOr(Schema.String),
  label: Schema.String,
  excerpt: Schema.String,
})

export const PagePart = Schema.Union([PageText, PageElement])

export type PagePart = typeof PagePart.Type

export const FilePage = Schema.TaggedStruct("FilePage", { path: Schema.String })

export const WebPage = Schema.TaggedStruct("WebPage", { url: Schema.String })

export const PageLocation = Schema.Union([FilePage, WebPage])

export type PageLocation = typeof PageLocation.Type

export class PageNote extends Schema.TaggedClass<PageNote>()("PageNote", {
  id: Schema.String,
  page: PageLocation,
  part: PagePart,
  text: NoteText,
}) {}

export const FeedbackNote = Schema.Union([LineNote, PageNote])

export type FeedbackNote = typeof FeedbackNote.Type

export const isLineNote = Schema.is(LineNote)

export const isPageNote = Schema.is(PageNote)

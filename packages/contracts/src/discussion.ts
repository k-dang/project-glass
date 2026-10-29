import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { Review } from "./review"

export const DiffSide = Schema.Literals(["old", "new"])

export type DiffSide = typeof DiffSide.Type

export const OriginalLine = Schema.Union([Schema.Int, Schema.Literal("whole-file")])

export type OriginalLine = typeof OriginalLine.Type

export class PublishedComment extends Schema.TaggedClass<PublishedComment>()("PublishedComment", {
  id: Schema.String,
  author: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  bodyHtml: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
}) {}

/** GitHub anchors multiline comments on their last line. */
export class LineDiscussion extends Schema.Class<LineDiscussion>("LineDiscussion")({
  id: Schema.String,
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int,
  resolved: Schema.Boolean,
  comments: Schema.NonEmptyArray(PublishedComment),
}) {}

export class OutdatedDiscussion extends Schema.Class<OutdatedDiscussion>("OutdatedDiscussion")({
  id: Schema.String,
  path: Schema.String,
  originalLine: OriginalLine,
  diffHunk: Schema.String,
  resolved: Schema.Boolean,
  comments: Schema.NonEmptyArray(PublishedComment),
}) {}

export class Discussions extends Schema.Class<Discussions>("Discussions")({
  onLines: Schema.Array(LineDiscussion),
  outdated: Schema.Array(OutdatedDiscussion),
  timeline: Schema.Array(Schema.Union([PublishedComment, Review])),
}) {}

export class DiscussionNotFound extends Schema.TaggedError<DiscussionNotFound>()(
  "DiscussionNotFound",
  { id: Schema.String },
) {}

export class DraftsBlockReply extends Schema.TaggedError<DraftsBlockReply>()(
  "DraftsBlockReply",
  {},
) {}

export const ReplyError = Schema.Union([DiscussionNotFound, DraftsBlockReply, ConnectionError])

export const DiscussionResolutionError = Schema.Union([DiscussionNotFound, ConnectionError])

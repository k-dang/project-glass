import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { Review } from "./review"

export const DiffSide = Schema.Literals(["old", "new"])

export type DiffSide = typeof DiffSide.Type

export const OriginalLine = Schema.Union([Schema.Int, Schema.Literal("whole-file")])

export type OriginalLine = typeof OriginalLine.Type

export const Reaction = Schema.Literals([
  "thumbs-up",
  "thumbs-down",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
])

export type Reaction = typeof Reaction.Type

export class ReactionGroup extends Schema.Class<ReactionGroup>("ReactionGroup")({
  reaction: Reaction,
  count: Schema.Int,
  reacted: Schema.Boolean,
}) {}

export class PublishedComment extends Schema.TaggedClass<PublishedComment>()("PublishedComment", {
  id: Schema.String,
  author: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  bodyHtml: Schema.String,
  createdAt: Schema.DateTimeUtcFromString,
  reactions: Schema.Array(ReactionGroup),
}) {}

// WARNING: GitHub anchors multiline comments on their last line.
export class LineReviewThread extends Schema.Class<LineReviewThread>("LineReviewThread")({
  id: Schema.String,
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int,
  resolved: Schema.Boolean,
  comments: Schema.NonEmptyArray(PublishedComment),
}) {}

export class OutdatedReviewThread extends Schema.Class<OutdatedReviewThread>(
  "OutdatedReviewThread",
)({
  id: Schema.String,
  path: Schema.String,
  originalLine: OriginalLine,
  diffHunk: Schema.String,
  resolved: Schema.Boolean,
  comments: Schema.NonEmptyArray(PublishedComment),
}) {}

export const TimelineItem = Schema.Union([PublishedComment, Review])

export type TimelineItem = typeof TimelineItem.Type

export class ReviewThreadNotFound extends Schema.TaggedError<ReviewThreadNotFound>()(
  "ReviewThreadNotFound",
  { id: Schema.String },
) {}

export class DraftsBlockReply extends Schema.TaggedError<DraftsBlockReply>()(
  "DraftsBlockReply",
  {},
) {}

export const ReplyError = Schema.Union([ReviewThreadNotFound, DraftsBlockReply, ConnectionError])

export const ReviewThreadResolutionError = Schema.Union([ReviewThreadNotFound, ConnectionError])

export class CommentNotFound extends Schema.TaggedError<CommentNotFound>()("CommentNotFound", {
  id: Schema.String,
}) {}

export const ReactionError = Schema.Union([CommentNotFound, ConnectionError])

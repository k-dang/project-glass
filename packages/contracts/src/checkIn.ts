import { Schema, Struct } from "effect"
import { FeedbackNote } from "./feedbackNote"
import { ChangedFile } from "./pullRequest"

/** A Check-in waiting in the Inbox. Its changes are read apart, so Needs you stays small. */
export const CheckIn = Schema.TaggedStruct("CheckIn", {
  id: Schema.String,
  folder: Schema.String,
  summary: Schema.NullOr(Schema.String),
  askedBy: Schema.String,
  since: Schema.DateTimeUtcFromString,
})

export type CheckIn = typeof CheckIn.Type

/** The changes a Check-in asked about, as they stood when it asked. */
export class CheckInChanges extends Schema.Class<CheckInChanges>("CheckInChanges")({
  id: Schema.String,
  baseRef: Schema.String,
  files: Schema.Array(ChangedFile),
}) {}

const answered = { message: Schema.NullOr(Schema.Trimmed.check(Schema.isNonEmpty())) }

export const CheckInApprove = Schema.TaggedStruct("Approve", answered)

export const CheckInSendFeedback = Schema.TaggedStruct("SendFeedback", answered)

export const CheckInAnswer = Schema.Union([CheckInApprove, CheckInSendFeedback])

export type CheckInAnswer = typeof CheckInAnswer.Type

export class CheckInNotWaiting extends Schema.TaggedError<CheckInNotWaiting>()(
  "CheckInNotWaiting",
  {},
) {}

export class CheckInError extends Schema.TaggedError<CheckInError>()("CheckInError", {
  message: Schema.String,
}) {}

export const checkInNoteKeys = ["path", "side", "start", "end", "code", "text"] as const

export const CheckInNote = Schema.Struct({
  ...Struct.pick(FeedbackNote.fields, checkInNoteKeys),
  outdated: Schema.Boolean,
})

export type CheckInNote = typeof CheckInNote.Type

const sent = { ...answered, notes: Schema.Array(CheckInNote) }

export const CheckInApproved = Schema.TaggedStruct("Approved", sent)

export const CheckInFeedback = Schema.TaggedStruct("Feedback", sent)

export const CheckInNoChanges = Schema.TaggedStruct("NoChanges", {})

export const CheckInTimedOut = Schema.TaggedStruct("TimedOut", {})

export const CheckInCancelled = Schema.TaggedStruct("Cancelled", {})

export const CheckInResult = Schema.Union([
  CheckInApproved,
  CheckInFeedback,
  CheckInNoChanges,
  CheckInTimedOut,
  CheckInCancelled,
])

export type CheckInResult = typeof CheckInResult.Type

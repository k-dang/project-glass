import { Schema } from "effect"
import { CheckInApproved, CheckInFeedback, CheckInReplaced } from "./checkIn"
import { QuestionAnswered, QuestionSetAside, QuestionWaiting } from "./question"

export const QuestionOutcome = Schema.Union([QuestionAnswered, QuestionSetAside])

export const QuestionState = Schema.Union([QuestionWaiting, ...QuestionOutcome.members])

export type QuestionState = typeof QuestionState.Type

export const CheckInOutcome = Schema.Union([
  CheckInApproved,
  CheckInFeedback,
  QuestionSetAside,
  CheckInReplaced,
])

export const CheckInState = Schema.Union([QuestionWaiting, ...CheckInOutcome.members])

export type CheckInState = typeof CheckInState.Type

export const AnswerState = Schema.Union([...CheckInState.members, QuestionAnswered])

export const ListedQuestion = Schema.TaggedStruct("Question", {
  id: Schema.String,
  question: Schema.String,
  since: Schema.DateTimeUtcFromString,
  state: QuestionState,
})

export type ListedQuestion = typeof ListedQuestion.Type

export const ListedCheckIn = Schema.TaggedStruct("CheckIn", {
  id: Schema.String,
  folder: Schema.String,
  summary: Schema.NullOr(Schema.String),
  since: Schema.DateTimeUtcFromString,
  state: CheckInState,
})

export type ListedCheckIn = typeof ListedCheckIn.Type

export const ListedAnswer = Schema.Union([ListedQuestion, ListedCheckIn])

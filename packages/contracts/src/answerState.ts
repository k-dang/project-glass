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

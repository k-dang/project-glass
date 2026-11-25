import { Schema } from "effect"

export const QuestionChoice = Schema.Struct({
  label: Schema.String,
  description: Schema.NullOr(Schema.String),
})

export type QuestionChoice = typeof QuestionChoice.Type

export const OpenQuestion = Schema.Struct({
  id: Schema.String,
  question: Schema.String,
  choices: Schema.Array(QuestionChoice),
  since: Schema.DateTimeUtcFromString,
})

export type OpenQuestion = typeof OpenQuestion.Type

export const ChoiceAnswer = Schema.TaggedStruct("Choice", { choice: Schema.String })

export const TextAnswer = Schema.TaggedStruct("Text", {
  text: Schema.Trimmed.check(Schema.isNonEmpty()),
})

export const QuestionAnswer = Schema.Union([ChoiceAnswer, TextAnswer])

export type QuestionAnswer = typeof QuestionAnswer.Type

export const GivenAnswer = Schema.Struct({ questionId: Schema.String, answer: QuestionAnswer })

export type GivenAnswer = typeof GivenAnswer.Type

export class QuestionNotOpen extends Schema.TaggedError<QuestionNotOpen>()("QuestionNotOpen", {
  message: Schema.String,
}) {}

export const ASK_USER_TOOL = "ask_user"

export const AskedUser = Schema.Struct({ questionId: Schema.String })

export const QuestionWaiting = Schema.TaggedStruct("Waiting", {})

export const QuestionAnswered = Schema.TaggedStruct("Answered", {
  answer: Schema.String,
  by: Schema.Literals(["choice", "text"]),
})

export type QuestionAnswered = typeof QuestionAnswered.Type

export const QuestionSetAside = Schema.TaggedStruct("SetAside", {})

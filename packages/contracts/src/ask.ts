import { Schema } from "effect"
import { CheckoutRunReason } from "./checkoutRun"
import { DiffSide } from "./discussion"
import { AgentRunnerIdentity } from "./engine"

export const AskQuestion = Schema.Trimmed.check(Schema.isNonEmpty())

export const AskPlace = Schema.Struct({
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int.check(Schema.isGreaterThan(0)),
})

export type AskPlace = typeof AskPlace.Type

export const AskAnswer = Schema.Struct({
  answer: Schema.String,
  runner: AgentRunnerIdentity,
})

export type AskAnswer = typeof AskAnswer.Type

export class AskFailure extends Schema.TaggedError<AskFailure>()("AskFailure", {
  reason: CheckoutRunReason,
  message: Schema.String,
  runner: Schema.NullOr(AgentRunnerIdentity),
}) {}

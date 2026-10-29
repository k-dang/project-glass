import { PiModel } from "@glass/contracts"
import { Schema } from "effect"
import { AgentFailure } from "./agentFailure"

export const PiConfigJson = Schema.fromJsonString(PiModel)

export const PiReady = Schema.fromJsonString(Schema.Union([Schema.Literal("ready"), AgentFailure]))

export const PiRequest = Schema.fromJsonString(
  Schema.Struct({ instructions: Schema.String, prompt: Schema.NonEmptyString }),
)

export const PiAnswerMessage = Schema.Struct({
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
})

export const PiAnswerJson = Schema.fromJsonString(PiAnswerMessage)

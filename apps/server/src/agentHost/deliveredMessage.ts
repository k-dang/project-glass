import { MessageWithContext, TurnMessage } from "@glass/contracts"
import { Schema } from "effect"

export const DeliveredMessage = Schema.Struct({
  ...MessageWithContext.fields,
  prompt: Schema.String,
})

export type DeliveredMessage = typeof DeliveredMessage.Type

export const DeliveredTurn = Schema.Struct({ ...TurnMessage.fields, prompt: Schema.String })

export type DeliveredTurn = typeof DeliveredTurn.Type

import { MessageWithContext } from "@glass/contracts"
import { Schema } from "effect"

export const DeliveredMessage = Schema.Struct({
  ...MessageWithContext.fields,
  prompt: Schema.String,
})

export type DeliveredMessage = typeof DeliveredMessage.Type

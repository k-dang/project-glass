import { SentMessage } from "@glass/contracts"
import { Schema } from "effect"

export const DeliveredMessage = Schema.Struct({ ...SentMessage.fields, prompt: Schema.String })

export type DeliveredMessage = typeof DeliveredMessage.Type

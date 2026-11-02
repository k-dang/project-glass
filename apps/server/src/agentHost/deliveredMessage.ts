import { SentMessage } from "@glass/contracts"
import { Schema } from "effect"

/**
 * A message as the backend hands it to the host: what the user wrote, which the transcript keeps,
 * and the `prompt` the Agent program reads in its place.
 */
export const DeliveredMessage = Schema.Struct({ ...SentMessage.fields, prompt: Schema.String })

export type DeliveredMessage = typeof DeliveredMessage.Type

import { Image, MessageWithContext, TurnMessage } from "@glass/contracts"
import { Schema } from "effect"

// Images of the To-dos the message mentions: the agent sees them, but the Turn and its Steers
// keep only the user's own images.
const MentionedImages = Schema.optionalKey(Schema.Array(Image))

export const DeliveredMessage = Schema.Struct({
  ...MessageWithContext.fields,
  prompt: Schema.String,
  mentionedImages: MentionedImages,
})

export type DeliveredMessage = typeof DeliveredMessage.Type

export const DeliveredTurn = Schema.Struct({
  ...TurnMessage.fields,
  prompt: Schema.String,
  mentionedImages: MentionedImages,
})

export type DeliveredTurn = typeof DeliveredTurn.Type

export const agentImages = ({
  images,
  mentionedImages = [],
}: Pick<DeliveredTurn, "images" | "mentionedImages">) => [...images, ...mentionedImages]

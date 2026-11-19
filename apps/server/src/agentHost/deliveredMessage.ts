import { Image, MessageWithContext, TurnMessage } from "@glass/contracts"
import { Schema } from "effect"

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

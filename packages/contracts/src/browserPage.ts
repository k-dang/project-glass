import { Schema } from "effect"

export class BrowserPageRequest extends Schema.Class<BrowserPageRequest>("BrowserPageRequest")({
  id: Schema.String,
  threadId: Schema.String,
  restoreLastPage: Schema.Boolean,
}) {}

export const BrowserPageReady = Schema.TaggedStruct("BrowserPageReady", { endpoint: Schema.String })

export const BrowserPageRefused = Schema.TaggedStruct("BrowserPageRefused", {
  message: Schema.String,
})

export const BrowserPageAnswer = Schema.Union([BrowserPageReady, BrowserPageRefused])

export type BrowserPageAnswer = typeof BrowserPageAnswer.Type

export class BrowserControl extends Schema.Class<BrowserControl>("BrowserControl")({
  threadId: Schema.String,
  agentUsing: Schema.Boolean,
  userTookOver: Schema.Boolean,
}) {}

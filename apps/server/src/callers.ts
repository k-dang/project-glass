import { Schema } from "effect"

export class GlobalChatCaller extends Schema.TaggedClass<GlobalChatCaller>()("GlobalChat", {
  globalChatId: Schema.String,
  sessionId: Schema.String,
}) {}

export class OutsideAgentCaller extends Schema.TaggedClass<OutsideAgentCaller>()("OutsideAgent", {
  agentId: Schema.String,
  name: Schema.String,
}) {}

export class ThreadCaller extends Schema.TaggedClass<ThreadCaller>()("Thread", {
  threadId: Schema.String,
}) {}

export const Caller = Schema.Union([GlobalChatCaller, ThreadCaller, OutsideAgentCaller])

export type Caller = typeof Caller.Type

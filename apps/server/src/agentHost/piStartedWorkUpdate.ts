import { Predicate, Schema } from "effect"
import { type PiEvent, ToolCall } from "./piRpc"

const otherThan = (...known: ReadonlyArray<string>) =>
  Schema.String.check(Schema.makeFilter((value) => !known.includes(value)))

const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const OtherBlock = Schema.Struct({ type: otherThan("text") })

const UserMessage = Schema.Struct({
  role: Schema.Literal("user"),
  content: Schema.Union([Schema.String, Schema.Array(Schema.Union([TextBlock, OtherBlock]))]),
})

const AssistantMessage = Schema.Struct({
  role: Schema.Literal("assistant"),
  content: Schema.Array(
    Schema.Union([
      TextBlock,
      Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
      Schema.Struct({ type: Schema.Literal("toolCall"), ...ToolCall.fields }),
      Schema.Struct({ type: otherThan("text", "thinking", "toolCall") }),
    ]),
  ),
  stopReason: Schema.String,
  errorMessage: Schema.optional(Schema.String),
})

const ToolResultMessage = Schema.Struct({
  role: Schema.Literal("toolResult"),
  toolCallId: Schema.String,
  content: Schema.Array(Schema.Union([TextBlock, OtherBlock])),
  isError: Schema.Boolean,
})

const isUser = Schema.is(UserMessage)

const isAssistant = Schema.is(AssistantMessage)

const isToolResult = Schema.is(ToolResultMessage)

const tree = { id: Schema.String, parentId: Schema.NullOr(Schema.String) }

const MessageEntry = Schema.Struct({
  ...tree,
  type: Schema.Literal("message"),
  message: Schema.Union([
    UserMessage,
    AssistantMessage,
    ToolResultMessage,
    Schema.Struct({ role: otherThan("user", "assistant", "toolResult") }),
  ]),
})

const ContextEditEntry = Schema.Struct({
  ...tree,
  type: Schema.Literal("context_edit"),
  targetId: Schema.String,
  replacement: Schema.Unknown,
})

const isMessageEntry = Schema.is(MessageEntry)

const isContextEdit = Schema.is(ContextEditEntry)

const SessionEntry = Schema.Union([
  MessageEntry,
  ContextEditEntry,
  Schema.Struct({ ...tree, type: otherThan("message", "context_edit") }),
])

type SessionEntry = typeof SessionEntry.Type

export const SessionEntries = Schema.Struct({
  entries: Schema.Array(SessionEntry),
  leafId: Schema.NullOr(Schema.String),
})

const activeBranch = ({ entries, leafId }: typeof SessionEntries.Type) => {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const branch: Array<SessionEntry> = []

  for (let entry = leafId === null ? undefined : byId.get(leafId); entry !== undefined;) {
    branch.push(entry)
    entry = entry.parentId === null ? undefined : byId.get(entry.parentId)
  }

  return branch.toReversed()
}

export type StartedWorkUpdateDelivery =
  | {
      readonly state: "pending" | "responding"
      readonly prompt: string
      readonly events: ReadonlyArray<PiEvent>
    }
  | { readonly state: "completed"; readonly events: ReadonlyArray<PiEvent> }

export const startedWorkUpdateDelivery = (
  turnId: string,
  prompt: string,
  session: typeof SessionEntries.Type,
): StartedWorkUpdateDelivery => {
  const entries = activeBranch(session)
  const identity = `\n\n<glass_started_work_update_turn>${turnId}</glass_started_work_update_turn>`

  const omitted = new Set<string>()

  for (const entry of entries)
    if (isContextEdit(entry)) {
      if (entry.replacement === null) omitted.add(entry.targetId)
      else omitted.delete(entry.targetId)
    }

  const messages = entries.flatMap((entry) =>
    isMessageEntry(entry) && !omitted.has(entry.id) ? [entry.message] : [],
  )

  const accepted = messages.findIndex(
    (message) =>
      isUser(message) &&
      (Predicate.isString(message.content)
        ? message.content
        : message.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("\n")
      ).endsWith(identity),
  )

  if (accepted === -1) return { state: "pending", prompt: prompt + identity, events: [] }

  const saved = messages.slice(accepted)
  const events: Array<PiEvent> = []

  for (const message of saved) {
    if (isUser(message)) {
      events.push({ type: "message_start", message: { role: "user" } })
    } else if (isAssistant(message)) {
      events.push({ type: "message_start", message: { role: "assistant" } })

      for (const [contentIndex, block] of message.content.entries()) {
        if ("text" in block)
          events.push({
            type: "message_update",
            assistantMessageEvent: { type: "text_end", contentIndex, content: block.text },
          })
        else if ("thinking" in block)
          events.push({
            type: "message_update",
            assistantMessageEvent: { type: "thinking_end", contentIndex, content: block.thinking },
          })
        else if ("arguments" in block)
          events.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_end",
              toolCall: { id: block.id, name: block.name, arguments: block.arguments },
            },
          })
      }

      events.push({
        type: "message_end",
        message: {
          role: "assistant",
          stopReason: message.stopReason,
          errorMessage: message.errorMessage,
        },
      })
    } else if (isToolResult(message)) {
      events.push({
        type: "tool_execution_end",
        toolCallId: message.toolCallId,
        result: {
          content: message.content.map((block) =>
            "text" in block ? { type: "text", text: block.text } : { type: block.type },
          ),
        },
        isError: message.isError,
      })
    }
  }

  const last = saved.at(-1)

  if (
    isAssistant(last) &&
    (last.stopReason === "stop" || last.stopReason === "length" || last.stopReason === "error")
  )
    return { state: "completed", events }

  return {
    state: "responding",
    prompt:
      "Glass restarted while you were writing the Started work update above. Finish that Started work update using the saved conversation. Do not repeat what you already said or take any action on the user's behalf.",
    events,
  }
}

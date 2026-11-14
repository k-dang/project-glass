import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { Predicate } from "effect"
import type { PiEvent } from "./piRpc"

export type ReportDelivery =
  | {
      readonly state: "pending" | "responding"
      readonly prompt: string
      readonly events: ReadonlyArray<PiEvent>
    }
  | { readonly state: "reported"; readonly events: ReadonlyArray<PiEvent> }

/** Uses the full saved branch, including messages before compaction, to find this Report. */
export const reportDelivery = (
  turnId: string,
  prompt: string,
  entries: ReadonlyArray<SessionEntry>,
): ReportDelivery => {
  const identity = `\n\n<glass_report_turn>${turnId}</glass_report_turn>`
  const omitted = new Set<string>()

  for (const entry of entries)
    if (entry.type === "context_edit") {
      if (entry.replacement === null) omitted.add(entry.targetId)
      else omitted.delete(entry.targetId)
    }

  const messages = entries.flatMap((entry) =>
    entry.type === "message" && !omitted.has(entry.id) ? [entry.message] : [],
  )

  const accepted = messages.findIndex(
    (message) =>
      message.role === "user" &&
      (Predicate.isString(message.content)
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
      ).endsWith(identity),
  )

  if (accepted === -1) return { state: "pending", prompt: prompt + identity, events: [] }

  const saved = messages.slice(accepted)
  const events: Array<PiEvent> = []

  for (const message of saved) {
    if (message.role === "user") {
      events.push({ type: "message_start", message: { role: "user" } })
    } else if (message.role === "assistant") {
      events.push({ type: "message_start", message: { role: "assistant" } })

      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === "text" || block.type === "thinking")
          events.push({
            type: "message_update",
            assistantMessageEvent: {
              type: block.type === "text" ? "text_end" : "thinking_end",
              contentIndex,
              content: block.type === "text" ? block.text : block.thinking,
            },
          })
        else if (block.type === "toolCall")
          events.push({
            type: "message_update",
            assistantMessageEvent: {
              type: "toolcall_end",
              toolCall: block,
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
    } else if (message.role === "toolResult") {
      events.push({
        type: "tool_execution_end",
        toolCallId: message.toolCallId,
        result: {
          content: message.content.map((block) =>
            block.type === "text" ? { type: "text", text: block.text } : { type: block.type },
          ),
        },
        isError: message.isError,
      })
    }
  }

  const last = saved.at(-1)

  if (
    last?.role === "assistant" &&
    (last.stopReason === "stop" || last.stopReason === "length" || last.stopReason === "error")
  )
    return { state: "reported", events }

  return {
    state: "responding",
    prompt:
      "Glass restarted while you were writing the Report above. Finish that Report using the saved conversation. Do not repeat what you already reported or take any action on the user's behalf.",
    events,
  }
}

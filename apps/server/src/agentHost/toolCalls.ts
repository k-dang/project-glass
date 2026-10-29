import { PermissionRequestPart, ToolCallPart } from "@glass/contracts"
import { Predicate, Schema } from "effect"

export const ToolInput = Schema.Record(Schema.String, Schema.Json)

export type ToolInput = typeof ToolInput.Type

const MAX_OUTPUT_CHARS = 100_000

const SUMMARY_CHARS = 160

const oneLine = (text: string) => {
  const flattened = text.replace(/\s+/g, " ").trim()

  return flattened.length > SUMMARY_CHARS ? `${flattened.slice(0, SUMMARY_CHARS - 1)}…` : flattened
}

const summarizeInput = (input: ToolInput) => {
  const named = ["command", "path", "file_path", "pattern", "url", "query"]
    .map((key) => input[key])
    .find(Predicate.isString)

  return oneLine(named ?? Object.values(input).find(Predicate.isString) ?? "")
}

export const runningToolCall = (
  toolCallId: string,
  name: string,
  input: ToolInput,
  parentToolCallId: string | null,
) =>
  ToolCallPart.make({
    toolCallId,
    name,
    inputSummary: summarizeInput(input),
    input: JSON.stringify(input, null, 2),
    output: null,
    status: "running",
    parentToolCallId,
  })

export const permissionRequest = (requestId: string, toolName: string, input: ToolInput) =>
  PermissionRequestPart.make({
    requestId,
    toolName,
    inputSummary: summarizeInput(input),
    input: JSON.stringify(input, null, 2),
    status: "waiting",
    reason: null,
  })

export const toolOutput = (text: string) =>
  text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n… (output cut short)` : text

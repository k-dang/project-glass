import { Effect, Redacted, Schema } from "effect"
import { McpSchema } from "effect/ai"
import { MCP_PATH } from "../src/mcp/server"

export interface JsonRpcMessage {
  readonly jsonrpc: "2.0"
  readonly id?: number
  readonly method: string
  readonly params?: Schema.JsonObject
}

const JsonRpcResponse = Schema.fromJsonString(
  Schema.Struct({
    result: Schema.optional(Schema.Unknown),
    error: Schema.optional(Schema.Unknown),
  }),
)

const decodeResponse = Schema.decodeUnknownSync(JsonRpcResponse)

export interface McpResponse {
  readonly status: number
  readonly sessionId: string | undefined
  readonly messages: ReadonlyArray<typeof JsonRpcResponse.Type>
}

export const mcpPost = (
  baseUrl: string,
  message: JsonRpcMessage,
  options: {
    readonly bearer?: Redacted.Redacted
    readonly sessionId?: string
    readonly headers?: Record<string, string>
    readonly query?: string
  } = {},
) =>
  Effect.promise(async (): Promise<McpResponse> => {
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...options.headers,
    })

    if (options.bearer !== undefined) {
      headers.set("authorization", `Bearer ${Redacted.value(options.bearer)}`)
    }

    if (options.sessionId !== undefined) headers.set("mcp-session-id", options.sessionId)

    const response = await fetch(`${baseUrl}${MCP_PATH}${options.query ?? ""}`, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    })

    const text = await response.text()

    const bodies = response.headers.get("content-type")?.startsWith("text/event-stream")
      ? text.split("\n").flatMap((line) => (line.startsWith("data:") ? [line.slice(5)] : []))
      : [text]

    return {
      status: response.status,
      sessionId: response.headers.get("mcp-session-id") ?? undefined,
      messages: bodies.filter((body) => body.trim() !== "").map((body) => decodeResponse(body)),
    }
  })

export const initialize: JsonRpcMessage = {
  jsonrpc: "2.0",
  id: 0,
  method: "initialize",
  params: {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "glass-test", version: "1.0.0" },
  },
}

export const connectMcp = Effect.fnUntraced(function* (baseUrl: string, bearer: Redacted.Redacted) {
  const initialized = yield* mcpPost(baseUrl, initialize, { bearer })
  const sessionId = initialized.sessionId

  if (initialized.status !== 200 || sessionId === undefined) {
    return yield* Effect.die(`MCP initialize failed with ${initialized.status}`)
  }

  let lastId = 0

  const send = (message: JsonRpcMessage, credential: Redacted.Redacted = bearer) =>
    mcpPost(baseUrl, message, { bearer: credential, sessionId })

  yield* send({ jsonrpc: "2.0", method: "notifications/initialized" })

  return {
    send,
    request: (method: string, params: Schema.JsonObject, credential?: Redacted.Redacted) => {
      const id = ++lastId

      return { id, response: send({ jsonrpc: "2.0", id, method, params }, credential) }
    },
  }
})

const decodeTools = Schema.decodeUnknownSync(McpSchema.ListToolsResult)

const decodeToolResult = Schema.decodeUnknownSync(McpSchema.CallToolResult)

const resultOrThrow = (response: McpResponse) => {
  const message = response.messages[0]

  if (message?.result === undefined) {
    throw new Error(`MCP ${response.status} without a result: ${JSON.stringify(message?.error)}`)
  }

  return message.result
}

export const listedTools = (response: McpResponse) => decodeTools(resultOrThrow(response)).tools

export const toolResult = (response: McpResponse) => decodeToolResult(resultOrThrow(response))

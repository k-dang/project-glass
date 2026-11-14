import { Redacted } from "effect"
import { GLASS_MCP_PREFIX } from "./toolCalls"
import type { GlassToolsAccess } from "./protocol"

const URL_VARIABLE = "GLASS_TOOLS_URL"

const BEARER_VARIABLE = "GLASS_TOOLS_BEARER"

export const PI_GLASS_TOOLS = `${GLASS_MCP_PREFIX}*`

export const piGlassToolsEnvironment = (access?: GlassToolsAccess) => ({
  [URL_VARIABLE]: access?.url ?? "",
  [BEARER_VARIABLE]: access === undefined ? "" : Redacted.value(access.bearer),
})

export const piGlassToolsExtension = `
const url = process.env[${JSON.stringify(URL_VARIABLE)}]
const bearer = process.env[${JSON.stringify(BEARER_VARIABLE)}]
delete process.env[${JSON.stringify(URL_VARIABLE)}]
delete process.env[${JSON.stringify(BEARER_VARIABLE)}]

let session
let lastId = 0

async function post(message, signal) {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: "Bearer " + bearer,
  }
  if (session !== undefined) headers["mcp-session-id"] = session
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(message), signal })
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "Glass no longer accepts this conversation's tool calls."
        : "Glass's tools answered " + response.status + ".",
    )
  session ??= response.headers.get("mcp-session-id") ?? undefined
  const text = await response.text()
  if (message.id === undefined) return undefined
  const bodies = (response.headers.get("content-type") ?? "").startsWith("text/event-stream")
    ? text.split("\\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5))
    : [text]
  for (const body of bodies) {
    if (body.trim() === "") continue
    const reply = JSON.parse(body)
    if (reply.id !== message.id) continue
    if (reply.error !== undefined) throw new Error(reply.error.message)
    return reply.result
  }
  throw new Error("Glass's tools didn't answer.")
}

async function request(method, params, signal) {
  const id = ++lastId
  const cancel = () =>
    void post({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id, reason: "The Turn stopped." },
    }).catch(() => {})
  signal?.addEventListener("abort", cancel, { once: true })
  try {
    return await post({ jsonrpc: "2.0", id, method, params }, signal)
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

export default async function (pi) {
  if (!url || !bearer) throw new Error("Glass gave this conversation no tools.")
  await request("initialize", {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "glass-pi", version: "1.0.0" },
  })
  await post({ jsonrpc: "2.0", method: "notifications/initialized" })
  const { tools } = await request("tools/list", {})
  for (const tool of tools)
    pi.registerTool({
      name: ${JSON.stringify(GLASS_MCP_PREFIX)} + tool.name,
      label: tool.annotations?.title ?? tool.name,
      description: tool.description ?? "",
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const result = await request("tools/call", { name: tool.name, arguments: params }, signal)
        const text = result.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\\n")
        if (result.isError) throw new Error(text)
        return { content: [{ type: "text", text }], details: undefined }
      },
    })
}
`

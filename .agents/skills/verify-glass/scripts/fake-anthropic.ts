import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { createServer, type ServerResponse } from "node:http"

/**
 * A local Anthropic Messages API for the real `claude`, so Claude Code Agents run without a model.
 * Asked to run a command in backticks, it calls Bash with it, so the CLI's own Permission mode decides
 * whether to ask. Asked to ask, it calls AskUserQuestion. Anything else gets a short reply.
 */

interface Block {
  readonly type: string
  readonly text?: string
  readonly content?: unknown
}

interface Message {
  readonly role: string
  readonly content: string | ReadonlyArray<Block>
}

interface Request {
  readonly model?: string
  readonly stream?: boolean
  readonly tools?: ReadonlyArray<unknown>
  readonly messages?: ReadonlyArray<Message>
}

type Reply =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: unknown }

const blocks = (message: Message | undefined): ReadonlyArray<Block> =>
  message === undefined
    ? []
    : typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((block: Block) => block.text ?? "").join("\n")
      : ""

// The CLI wraps a prompt in system reminders; the user's words are the last text block.
const lastWords = (message: Message | undefined) =>
  blocks(message)
    .filter((block) => block.type === "text" && !(block.text ?? "").startsWith("<system-reminder>"))
    .at(-1)?.text ?? ""

const replyTo = (request: Request): Reply => {
  // The CLI can end the conversation with its own system messages; the user's turn is what answers.
  const last = request.messages?.findLast((message) => message.role === "user")

  // Side requests, such as the CLI naming the session, carry no tools.
  if ((request.tools ?? []).length === 0) return { type: "text", text: "Fake session" }

  const words = lastWords(last)
  const result = blocks(last).find((block) => block.type === "tool_result")

  // After a stopped Turn the CLI sends the cancelled tool's result along with the next message.
  if (result !== undefined && words === "")
    return { type: "text", text: `The fake model saw: ${textOf(result.content).slice(0, 200)}` }
  const command = /`([^`]+)`/.exec(words)?.[1]

  if (command !== undefined)
    return { type: "tool_use", name: "Bash", input: { command, description: `Run ${command}` } }

  if (/\bask\b/i.test(words))
    return {
      type: "tool_use",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            header: "Scope",
            question: "Which files should I look at?",
            multiSelect: false,
            options: [
              { label: "Only the README", description: "The quickest overview" },
              { label: "Everything", description: "Every file in the checkout" },
            ],
          },
        ],
      },
    }

  return { type: "text", text: `Fake reply to: ${words.slice(0, 200)}` }
}

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const stream = (response: ServerResponse, model: string, reply: Reply) => {
  const id = `msg_${randomUUID()}`
  const event = (type: string, data: object) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)

  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
  event("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })

  if (reply.type === "text") {
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } })
    event("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text } })
  } else {
    event("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${randomUUID()}`, name: reply.name, input: {} },
    })
    event("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(reply.input) },
    })
  }

  event("content_block_stop", { index: 0 })
  event("message_delta", {
    delta: { stop_reason: reply.type === "text" ? "end_turn" : "tool_use", stop_sequence: null },
    usage: { output_tokens: 1 },
  })
  event("message_stop", {})
  response.end()
}

const message = (model: string, reply: Reply) => ({
  id: `msg_${randomUUID()}`,
  type: "message",
  role: "assistant",
  model,
  content: [
    reply.type === "text"
      ? reply
      : { type: "tool_use", id: `toolu_${randomUUID()}`, name: reply.name, input: reply.input },
  ],
  stop_reason: reply.type === "text" ? "end_turn" : "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
})

export const serveFakeAnthropic = (readyFile: string) =>
  new Promise<never>(() => {
    const server = createServer((request, response) => {
      let body = ""
      request.on("data", (chunk: Buffer) => (body += chunk.toString()))
      request.on("end", () => {
        const path = (request.url ?? "").split("?")[0] ?? ""

        if (request.method !== "POST" || !path.startsWith("/v1/messages")) {
          console.log(`${new Date().toISOString()} ${request.method} ${path} -> 404`)
          return send(response, 404, { type: "error", error: { type: "not_found_error" } })
        }

        if (path === "/v1/messages/count_tokens") return send(response, 200, { input_tokens: 1 })

        const parsed = JSON.parse(body) as Request
        const model = parsed.model ?? "claude-fake"
        const reply = replyTo(parsed)
        console.log(
          `${new Date().toISOString()} messages ${model} -> ${reply.type === "text" ? "text" : reply.name}`,
        )

        return parsed.stream === true ? stream(response, model, reply) : send(response, 200, message(model, reply))
      })
    })

    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address !== null ? address.port : 0
      writeFileSync(readyFile, JSON.stringify({ port }))
    })
  })

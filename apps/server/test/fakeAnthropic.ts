import { Effect, Predicate, Result, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { createServer, type ServerResponse } from "node:http"
import { portOf } from "./ports.ts"

const TextBlock = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
})

const Content = Schema.Union([Schema.String, Schema.Array(TextBlock)])

const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  content: Schema.optional(Content),
})

const Message = Schema.Struct({
  role: Schema.String,
  content: Schema.Union([Schema.String, Schema.Array(Block)]),
})

const Request = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.optional(Schema.String),
    output_config: Schema.optional(Schema.Struct({ effort: Schema.optional(Schema.String) })),
    stream: Schema.optional(Schema.Boolean),
    tools: Schema.optional(Schema.Array(Schema.Unknown)),
    messages: Schema.optional(Schema.Array(Message)),
  }),
)

type Block = typeof Block.Type

type Message = typeof Message.Type

export type FakeAnthropicRequest = typeof Request.Type

type Answer =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: Schema.Json }

type Reply = Answer | { readonly type: "error"; readonly message: string }

const blocks = (message: Message | undefined): ReadonlyArray<Block> =>
  message === undefined
    ? []
    : Predicate.isString(message.content)
      ? [{ type: "text", text: message.content }]
      : message.content

const textOf = (content: typeof Content.Type | undefined): string =>
  Predicate.isString(content)
    ? content
    : (content ?? []).map((block) => block.text ?? "").join("\n")

const isSystemReminder = (text: string | undefined) => (text ?? "").startsWith("<system-reminder>")

const lastWords = (message: Message | undefined) =>
  blocks(message)
    .filter((block) => block.type === "text" && !isSystemReminder(block.text))
    .at(-1)?.text ?? ""

const isSideRequest = (request: FakeAnthropicRequest) => (request.tools ?? []).length === 0

export const lastUserWords = (request: FakeAnthropicRequest) =>
  lastWords(request.messages?.findLast((message) => message.role === "user"))

export const replyTo = (request: FakeAnthropicRequest): Reply => {
  const last = request.messages?.findLast((message) => message.role === "user")

  if (isSideRequest(request)) return { type: "text", text: "Fake session" }

  const words = lastWords(last)
  const result = blocks(last).find((block) => block.type === "tool_result")

  const onlyCancelledToolResult = result !== undefined && words === ""

  if (onlyCancelledToolResult)
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

  return { type: "text", text: `Fake reply to: ${words}` }
}

const send = (response: ServerResponse, status: number, body: Schema.Json) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const stream = (response: ServerResponse, model: string, reply: Answer) => {
  const id = `msg_${randomUUID()}`

  const event = (type: string, data: Readonly<Record<string, Schema.Json>>) =>
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

    for (const piece of reply.text.split(/(?<= )/))
      event("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } })
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

const message = (model: string, reply: Answer) => ({
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

export const startFakeAnthropic = Effect.gen(function* () {
  let respond: (request: FakeAnthropicRequest) => Reply = replyTo

  const server = createServer(async (request, response) => {
    const path = (request.url ?? "").split("?")[0] ?? ""

    if (request.method !== "POST" || !path.startsWith("/v1/messages"))
      return send(response, 404, { type: "error", error: { type: "not_found_error" } })

    if (path === "/v1/messages/count_tokens") return send(response, 200, { input_tokens: 1 })

    let body = ""

    for await (const chunk of request) body += chunk
    const decoded = Schema.decodeUnknownResult(Request)(body)

    if (Result.isFailure(decoded))
      return send(response, 400, { type: "error", error: { type: "invalid_request_error" } })

    const parsed = decoded.success
    const model = parsed.model ?? "claude-fake"
    const reply = respond(parsed)

    console.log(
      `${new Date().toISOString()} messages ${model} -> ${reply.type === "tool_use" ? reply.name : reply.type}`,
    )

    if (reply.type === "error")
      return send(response, 400, {
        type: "error",
        error: { type: "invalid_request_error", message: reply.message },
      })

    return parsed.stream === true
      ? stream(response, model, reply)
      : send(response, 200, message(model, reply))
  })

  yield* Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject)
          server.listen(0, "127.0.0.1", resolve)
        }),
    ),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
  )

  return {
    url: `http://127.0.0.1:${portOf(server)}`,
    respond: (reply: (request: FakeAnthropicRequest) => Reply) =>
      Effect.sync(() => {
        respond = reply
      }),
  }
})

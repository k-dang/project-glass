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

type Reply =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly name: string; readonly input: Schema.Json }

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

// The CLI wraps a prompt in system reminders; the user's words are the last text block.
const lastWords = (message: Message | undefined) =>
  blocks(message)
    .filter((block) => block.type === "text" && !(block.text ?? "").startsWith("<system-reminder>"))
    .at(-1)?.text ?? ""

const replyTo = (request: FakeAnthropicRequest): Reply => {
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

  return { type: "text", text: `Fake reply to: ${words}` }
}

const send = (response: ServerResponse, status: number, body: Schema.Json) => {
  response.writeHead(status, { "content-type": "application/json" })
  response.end(JSON.stringify(body))
}

const stream = (response: ServerResponse, model: string, reply: Reply) => {
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

const counter = () => {
  let seen = 0
  const waiting = new Set<{ readonly count: number; readonly wake: () => void }>()

  return {
    add: () => {
      seen++

      for (const waiter of waiting)
        if (seen >= waiter.count) {
          waiting.delete(waiter)
          waiter.wake()
        }
    },
    reached: (count: number) =>
      Effect.callback<void>((resume) => {
        if (seen >= count) return resume(Effect.void)

        const waiter = { count, wake: () => resume(Effect.void) }
        waiting.add(waiter)

        return Effect.sync(() => waiting.delete(waiter))
      }),
  }
}

/** The shared Messages API boundary for real Claude CLI integration and app verification. */
export const startFakeAnthropic = Effect.gen(function* () {
  const calls: Array<FakeAnthropicRequest> = []
  const received = counter()
  let held: Array<() => void> | null = null

  const releaseHeld = () => {
    const hold = held ?? []
    held = null

    for (const resume of hold) resume()
  }

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
    const reply = replyTo(parsed)

    const conversation = (parsed.tools ?? []).length > 0

    if (conversation) {
      calls.push(parsed)
      received.add()

      if (held !== null) {
        const hold = held
        await new Promise<void>((resolve) => hold.push(resolve))
      }
    }

    if (response.destroyed) return

    console.log(
      `${new Date().toISOString()} messages ${model} -> ${reply.type === "text" ? "text" : reply.name}`,
    )

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
            releaseHeld()
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
  )

  return {
    url: `http://127.0.0.1:${portOf(server)}`,
    /** The conversation's requests, leaving out side requests such as naming the session. */
    calls,
    received: received.reached,
    /** Keeps later replies back until `release`. */
    hold: Effect.sync(() => {
      held ??= []
    }),
    release: Effect.sync(releaseHeld),
  }
})

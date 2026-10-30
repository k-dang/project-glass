import { Effect, Predicate, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer, type ServerResponse } from "node:http"
import { join } from "node:path"
import { portOf } from "./ports.ts"

const request = Schema.fromJsonString(
  Schema.Struct({
    model: Schema.String,
    messages: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        content: Schema.optional(
          Schema.NullOr(
            Schema.Union([
              Schema.String,
              Schema.Array(
                Schema.Struct({
                  type: Schema.String,
                  text: Schema.optional(Schema.String),
                  image_url: Schema.optional(Schema.Struct({ url: Schema.String })),
                }),
              ),
            ]),
          ),
        ),
      }),
    ),
    tools: Schema.optional(Schema.Array(Schema.Unknown)),
    reasoning_effort: Schema.optional(Schema.String),
  }),
)

export type FakeModelRequest = typeof request.Type

export type FakeModelDelta =
  | { readonly text: string }
  | { readonly thinking: string }
  | {
      readonly toolCall: {
        readonly id: string
        readonly name: string
        readonly arguments: Readonly<Record<string, string>>
      }
    }

const lastUserText = ({ messages }: FakeModelRequest) => {
  const content = messages.findLast(({ role }) => role === "user")?.content

  return Predicate.isString(content)
    ? content
    : (content ?? []).map(({ text }) => text ?? "").join("")
}

export const runCommands =
  (commandsByMessage: Readonly<Record<string, string>>) =>
  (input: FakeModelRequest): ReadonlyArray<FakeModelDelta> =>
    input.messages.at(-1)?.role === "tool"
      ? [{ text: "Done." }]
      : [
          {
            toolCall: {
              id: `call-${input.messages.length}`,
              name: "bash",
              arguments: { command: commandsByMessage[lastUserText(input)] ?? "true" },
            },
          },
        ]

export interface FakeModelSettings {
  readonly output?: string | ((input: typeof request.Type) => string)
  readonly reply?: (input: FakeModelRequest) => ReadonlyArray<FakeModelDelta>
  readonly status?: number
  readonly failFirst?: number
  readonly hang?: boolean
  readonly finishReason?: "stop" | "length"
  /** How long to wait between the reply's chunks; replies stream at once without it. */
  readonly chunkDelay?: (input: FakeModelRequest) => number
}

interface CompletionDelta {
  readonly content?: string
  readonly reasoning_content?: string
  readonly tool_calls?: ReadonlyArray<{
    readonly index: number
    readonly id: string
    readonly type: "function"
    readonly function: { readonly name: string; readonly arguments: string }
  }>
}

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

const sseChunk = (delta: CompletionDelta, finishReason: string | null) =>
  `data: ${JSON.stringify({
    id: "test-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-test",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`

const replyChunks = (deltas: ReadonlyArray<FakeModelDelta>, finishReason = "stop") => {
  let toolCalls = 0

  const streamed = deltas.map((delta) => {
    if ("text" in delta) return sseChunk({ content: delta.text }, null)

    if ("thinking" in delta) return sseChunk({ reasoning_content: delta.thinking }, null)

    return sseChunk(
      {
        tool_calls: [
          {
            index: toolCalls++,
            id: delta.toolCall.id,
            type: "function",
            function: {
              name: delta.toolCall.name,
              arguments: JSON.stringify(delta.toolCall.arguments),
            },
          },
        ],
      },
      null,
    )
  })

  return [
    ...streamed,
    sseChunk({}, toolCalls > 0 ? "tool_calls" : finishReason),
    "data: [DONE]\n\n",
  ]
}

export interface PiSettings {
  readonly enabledModels?: ReadonlyArray<string>
  readonly retry?: {
    readonly enabled: boolean
    readonly maxRetries?: number
    readonly baseDelayMs?: number
  }
}

export const fakeModelProvider = Effect.fnUntraced(function* (
  home: string,
  initial: FakeModelSettings,
  piSettings: PiSettings = {},
) {
  let settings = initial
  const calls: Array<typeof request.Type> = []
  const authorizations: Array<string> = []
  const received = counter()
  const cancelled = counter()
  const hung: Array<{ readonly input: FakeModelRequest; readonly res: ServerResponse }> = []

  const reply = (current: FakeModelSettings, input: FakeModelRequest, res: ServerResponse) => {
    const output = Predicate.isFunction(current.output)
      ? current.output(input)
      : (current.output ?? "")

    const chunks = replyChunks(current.reply?.(input) ?? [{ text: output }], current.finishReason)
    const delay = current.chunkDelay?.(input) ?? 0

    const send = ([chunk, ...rest]: ReadonlyArray<string>) => {
      if (res.destroyed) return

      if (chunk === undefined) res.end()
      else {
        res.write(chunk)
        setTimeout(() => send(rest), delay)
      }
    }

    if (delay === 0) res.end(chunks.join(""))
    else send(chunks)
  }

  const server = createServer(async (req, res) => {
    let body = ""

    for await (const chunk of req) body += chunk
    const input = Schema.decodeUnknownSync(request)(body)
    calls.push(input)
    authorizations.push(req.headers.authorization ?? "")
    received.add()
    const current = settings

    if (current.failFirst !== undefined && calls.length <= current.failFirst) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "overloaded" } }))

      return
    }

    if (current.status !== undefined) {
      const output = Predicate.isFunction(current.output)
        ? current.output(input)
        : (current.output ?? "")

      res.writeHead(current.status, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: output } }))

      return
    }

    res.writeHead(200, { "content-type": "text/event-stream" })
    res.flushHeaders()

    if (current.hang) {
      res.on("close", cancelled.add)
      hung.push({ input, res })

      return
    }

    reply(current, input, res)
  })

  yield* Effect.acquireRelease(
    Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
    () =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            server.closeAllConnections()
            server.close((error) => (error ? reject(error) : resolve()))
          }),
      ),
  )
  const url = `http://127.0.0.1:${portOf(server)}/v1`
  const directory = join(home, ".pi", "agent")
  yield* Effect.promise(async () => {
    await mkdir(directory, { recursive: true })
    await mkdir(join(home, ".project-glass"), { recursive: true })
    await writeFile(
      join(directory, "auth.json"),
      JSON.stringify({
        "glass-test": { type: "api_key", key: "test-pi-key" },
      }),
    )
    await writeFile(
      join(directory, "models.json"),
      JSON.stringify({
        providers: {
          "glass-test": {
            baseUrl: url,
            api: "openai-completions",
            models: [
              {
                id: "gpt-test",
                reasoning: false,
                input: ["text", "image"],
                contextWindow: 128000,
                maxTokens: 4096,
              },
              {
                id: "gpt-test-thinking",
                name: "GPT Test Thinking",
                reasoning: true,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
              },
            ],
          },
        },
      }),
    )
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({ defaultProvider: "glass-test", defaultModel: "gpt-test", ...piSettings }),
    )
    await writeFile(
      join(home, ".project-glass", "settings.json"),
      JSON.stringify({
        tourModels: { pi: { provider: "glass-test", modelId: "gpt-test" } },
      }),
    )
  })

  return {
    url,
    calls,
    authorizations,
    received: received.reached,
    cancelled: cancelled.reached,
    configure: (next: FakeModelSettings) =>
      Effect.sync(() => {
        settings = next
      }),
    release: (next: FakeModelSettings) =>
      Effect.sync(() => {
        settings = next

        for (const { input, res } of hung.splice(0)) {
          res.off("close", cancelled.add)
          reply(next, input, res)
        }
      }),
  }
})

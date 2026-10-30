import { Cause, Deferred, Effect, Option, Predicate, Queue, Schema, Scope, Stream } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { launchCommand } from "../processes"
import { HostAgentError } from "./protocol"
import { ToolInput } from "./toolCalls"

// Longer than the 30 seconds pi waits on a lock a crashed pi left behind.
const REQUEST_TIMEOUT = "60 seconds"

const ToolResult = Schema.Struct({
  content: Schema.Array(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
})

export type ToolResult = typeof ToolResult.Type

const AssistantUpdate = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["text_start", "thinking_start"]),
    contentIndex: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literals(["text_delta", "thinking_delta"]),
    contentIndex: Schema.Int,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literals(["text_end", "thinking_end"]),
    contentIndex: Schema.Int,
    content: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    toolCall: Schema.Struct({ id: Schema.String, name: Schema.String, arguments: ToolInput }),
  }),
])

export type AssistantUpdate = typeof AssistantUpdate.Type

const Message = Schema.Struct({
  role: Schema.String,
  stopReason: Schema.optional(Schema.String),
  errorMessage: Schema.optional(Schema.String),
})

const PiEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["agent_start", "agent_settled"]) }),
  Schema.Struct({ type: Schema.Literals(["message_start", "message_end"]), message: Message }),
  Schema.Struct({ type: Schema.Literal("message_update"), assistantMessageEvent: AssistantUpdate }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: ToolInput,
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    result: ToolResult,
    isError: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("extension_ui_request"),
    id: Schema.String,
    method: Schema.String,
    title: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
    options: Schema.optional(Schema.Array(Schema.String)),
    /** Milliseconds until pi stops waiting for an answer. */
    timeout: Schema.optional(Schema.Number),
  }),
])

export type PiEvent = typeof PiEvent.Type

const Response = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.String,
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
})

const decodeRecord = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Union([Response, PiEvent])),
)

export interface PiImage {
  readonly type: "image"
  readonly data: string
  readonly mimeType: string
}

type PiCommand =
  | { readonly type: "prompt"; readonly message: string; readonly images: ReadonlyArray<PiImage> }
  | { readonly type: "steer"; readonly message: string; readonly images: ReadonlyArray<PiImage> }
  | { readonly type: "clear_queue" }
  | { readonly type: "abort" }
  | { readonly type: "get_state" }
  | { readonly type: "get_available_models" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }

export const PromptAccepted = Schema.Struct({ disposition: Schema.optional(Schema.String) })

export const ClearedQueue = Schema.Struct({
  steering: Schema.Array(Schema.String),
  followUp: Schema.Array(Schema.String),
})

const PiModel = Schema.Struct({
  provider: Schema.String,
  id: Schema.String,
  name: Schema.optional(Schema.String),
  reasoning: Schema.optional(Schema.Boolean),
  thinkingLevelMap: Schema.optional(Schema.Record(Schema.String, Schema.NullOr(Schema.Unknown))),
})

export type PiModel = typeof PiModel.Type

export const SessionState = Schema.Struct({
  model: Schema.optional(Schema.NullOr(PiModel)),
  isStreaming: Schema.Boolean,
  isCompacting: Schema.Boolean,
})

export const AvailableModels = Schema.Struct({ models: Schema.Array(PiModel) })

interface PiRpc {
  readonly events: Stream.Stream<PiEvent>
  readonly send: (command: PiCommand) => Effect.Effect<void>
  readonly request: <A>(command: PiCommand, schema: Schema.Decoder<A>) => Effect.Effect<A, string>
}

// pi's RPC framing is LF only: `readline` would also split on U+2028 and U+2029, which JSON strings may hold.
const lineFramer = () => {
  let pending: Array<string> = []

  return (chunk: string) => {
    const lines: Array<string> = []
    let start = 0

    for (let end = chunk.indexOf("\n"); end !== -1; end = chunk.indexOf("\n", start)) {
      const line = pending.join("") + chunk.slice(start, end)
      pending = []
      lines.push(line.endsWith("\r") ? line.slice(0, -1) : line)
      start = end + 1
    }

    if (start < chunk.length) pending.push(chunk.slice(start))

    return lines
  }
}

export const startPiRpc = Effect.fnUntraced(function* (
  piCommand: string,
  folder: string,
  conversation?: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const scope = yield* Scope.Scope

  const child = yield* spawner
    .spawn(
      launchCommand(
        piCommand,
        ["--mode", "rpc", ...(conversation === undefined ? [] : ["--session-id", conversation])],
        { cwd: folder, extendEnv: true, forceKillAfter: "1 second" },
      ),
    )
    .pipe(
      Effect.tapError((cause) => Effect.logWarning("pi could not start", cause)),
      Effect.mapError((error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? new HostAgentError({
              message: "pi isn't installed. Install it, or point GLASS_PI_COMMAND at it.",
            })
          : new HostAgentError({ message: "pi could not start. Check its installation." }),
      ),
    )

  const outgoing = yield* Queue.unbounded<Uint8Array>()
  const events = yield* Queue.unbounded<PiEvent, Cause.Done>()
  const pending = new Map<string, Deferred.Deferred<unknown, string>>()
  const encoder = new TextEncoder()
  let nextRequest = 0
  let exited = false

  const write = (record: PiCommand & { readonly id?: string }) =>
    Queue.offer(outgoing, encoder.encode(`${JSON.stringify(record)}\n`)).pipe(Effect.asVoid)

  const route = (line: string) =>
    Option.match(decodeRecord(line), {
      onNone: () => Effect.void,
      onSome: (record) => {
        if (record.type !== "response") return Queue.offer(events, record)

        const waiting = pending.get(record.id)

        if (waiting === undefined) return Effect.void

        return record.success
          ? Deferred.succeed(waiting, record.data)
          : Deferred.fail(
              waiting,
              Predicate.isString(record.error) ? record.error : "pi refused the command",
            )
      },
    })

  yield* Stream.fromQueue(outgoing).pipe(
    Stream.run(child.stdin),
    Effect.ignore,
    Effect.forkIn(scope),
  )

  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      chunk.trim() === "" ? Effect.void : Effect.logWarning("pi wrote to stderr", chunk),
    ),
    Effect.ignore,
    Effect.forkIn(scope),
  )

  yield* Effect.gen(function* () {
    const frame = lineFramer()

    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.runForEach((chunk) => Effect.forEach(frame(chunk), route, { discard: true })),
      Effect.ignore,
    )

    exited = true

    for (const waiting of pending.values()) yield* Deferred.fail(waiting, "pi has stopped")
    yield* Queue.end(events)
  }).pipe(Effect.forkIn(scope))

  return {
    events: Stream.fromQueue(events),
    send: write,
    request: <A>(command: PiCommand, schema: Schema.Decoder<A>) =>
      Effect.gen(function* () {
        if (exited) return yield* Effect.fail("pi has stopped")
        const id = `glass-${++nextRequest}`
        const response = yield* Deferred.make<unknown, string>()
        pending.set(id, response)
        yield* write({ ...command, id })

        const data = yield* Deferred.await(response).pipe(
          Effect.timeoutOrElse({
            duration: REQUEST_TIMEOUT,
            orElse: () => Effect.fail(`pi didn't answer ${command.type}`),
          }),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        )

        return yield* Schema.decodeUnknownEffect(schema)(data).pipe(
          Effect.mapError(() => `pi answered ${command.type} unexpectedly`),
        )
      }),
  } satisfies PiRpc
})

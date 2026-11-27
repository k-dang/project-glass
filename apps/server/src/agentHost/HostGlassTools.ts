import {
  type Cause,
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Queue,
  Redacted,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { digest, MCP_PATH } from "../mcp/mcpHttp"
import { Journal } from "./Journal"
import {
  failedToolCall,
  type GlassToolsAccess,
  HostReplaced,
  newHostToken,
  type RelayedToolCall,
} from "./protocol"

export class RelayedThread extends Context.Service<RelayedThread, { readonly threadId: string }>()(
  "@glass/server/agentHost/RelayedThread",
) {
  static readonly current = Effect.serviceOption(RelayedThread).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("Glass tool called outside an authenticated request"),
        onSome: Effect.succeed,
      }),
    ),
  )
}

interface RelayCredential {
  readonly threadId: string
  readonly ownedSessions: Set<string>
}

type Watcher = Queue.Queue<RelayedToolCall, Cause.Done>

interface Pending {
  readonly owner: Watcher
  readonly threadId: string
  readonly answered: Deferred.Deferred<McpSchema.CallToolResult>
}

export const notConnected = failedToolCall(
  "Glass isn't connected to this Thread, so its tools can't answer now. Try again later.",
)

export const lostConnection = failedToolCall(
  "Glass lost its connection during this call, so it may or may not have happened. Check list_threads or list_started_work before trying again.",
)

const encodeTools = Schema.encodeSync(Schema.fromJsonString(Schema.Array(McpSchema.Tool)))

export class HostGlassTools extends Context.Service<
  HostGlassTools,
  {
    readonly listening: (port: number) => Effect.Effect<void>
    readonly offer: (
      host: string,
      tools: ReadonlyArray<McpSchema.Tool>,
    ) => Effect.Effect<void, HostReplaced>
    readonly access: (threadId: string) => Effect.Effect<GlassToolsAccess, never, Scope.Scope>
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<RelayCredential>
    readonly call: (
      threadId: string,
      name: string,
      args: Schema.JsonObject,
    ) => Effect.Effect<McpSchema.CallToolResult>
    readonly watch: (host: string) => Stream.Stream<RelayedToolCall, HostReplaced>
    readonly answer: (
      host: string,
      callId: string,
      result: McpSchema.CallToolResult,
    ) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/HostGlassTools") {
  static readonly layer = Layer.effect(
    HostGlassTools,
    Effect.gen(function* () {
      const { host } = yield* Journal
      const server = yield* McpServer.McpServer
      const port = yield* Deferred.make<number>()
      const credentials = new Map<string, RelayCredential>()
      const pending = new Map<string, Pending>()
      let watcher: Watcher | null = null
      let offered = encodeTools([])

      const failPending = (matches: (waiting: Pending) => boolean) =>
        Effect.forEach(
          [...pending].filter(([, waiting]) => matches(waiting)),
          ([callId, waiting]) => {
            pending.delete(callId)

            return Deferred.succeed(waiting.answered, lostConnection)
          },
          { discard: true },
        )

      const call = (threadId: string, name: string, args: Schema.JsonObject) =>
        Effect.suspend(() => {
          const owner = watcher

          if (owner === null) return Effect.succeed(notConnected)

          const callId = newHostToken()
          const answered = Deferred.makeUnsafe<McpSchema.CallToolResult>()

          pending.set(callId, { owner, threadId, answered })
          Queue.offerUnsafe(owner, { callId, threadId, name, arguments: args })

          return Deferred.await(answered).pipe(
            Effect.ensuring(Effect.sync(() => pending.delete(callId))),
          )
        })

      const relayed = (name: string) => (args: Schema.JsonObject | undefined) =>
        RelayedThread.current.pipe(
          Effect.flatMap(({ threadId }) => call(threadId, name, args ?? {})),
        )

      const release = (ended: Watcher) =>
        Effect.suspend(() => {
          if (watcher === ended) watcher = null

          return Queue.clear(ended).pipe(
            Effect.andThen(Queue.end(ended)),
            Effect.andThen(failPending(({ owner }) => owner === ended)),
          )
        })

      return HostGlassTools.of({
        listening: (listened) => Deferred.succeed(port, listened).pipe(Effect.asVoid),
        offer: (offeredTo, tools) =>
          Effect.suspend(() => {
            if (offeredTo !== host) return Effect.fail(new HostReplaced())

            const encoded = encodeTools(tools)

            if (encoded === offered) return Effect.void

            return Effect.forEach(
              tools,
              (tool) =>
                server.addTool({ tool, annotations: Context.empty(), handle: relayed(tool.name) }),
              { discard: true },
            ).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  offered = encoded
                }),
              ),
            )
          }),
        access: (threadId) =>
          Effect.acquireRelease(
            Effect.sync(() => {
              const bearer = newHostToken()

              credentials.set(digest(bearer), { threadId, ownedSessions: new Set() })

              return bearer
            }),
            (bearer) =>
              Effect.sync(() => credentials.delete(digest(bearer))).pipe(
                Effect.andThen(failPending((waiting) => waiting.threadId === threadId)),
              ),
          ).pipe(
            Effect.flatMap((bearer) =>
              Deferred.await(port).pipe(
                Effect.map((listened) => ({
                  url: `http://127.0.0.1:${listened}${MCP_PATH}`,
                  bearer: Redacted.make(bearer),
                })),
              ),
            ),
          ),
        authenticate: (bearer) =>
          Option.fromNullishOr(credentials.get(digest(Redacted.value(bearer)))),
        call,
        watch: (watched) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (watched !== host) return yield* new HostReplaced()

              const next: Watcher = yield* Queue.unbounded<RelayedToolCall, Cause.Done>()
              const previous = watcher

              watcher = next
              yield* Effect.addFinalizer(() => release(next))

              if (previous !== null) yield* release(previous)

              return Stream.fromQueue(next)
            }),
          ),
        answer: (answeredFor, callId, result) =>
          Effect.suspend(() => {
            const answered = answeredFor === host ? pending.get(callId) : undefined

            if (answered === undefined) return Effect.void

            return Deferred.succeed(answered.answered, result).pipe(Effect.asVoid)
          }),
      })
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer))
}

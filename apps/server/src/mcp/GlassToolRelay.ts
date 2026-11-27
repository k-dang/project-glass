import { Context, Data, Deferred, Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { SqlClient } from "effect/sql"
import { failedToolCall, type RelayedToolCall } from "../agentHost/protocol"
import { annotateUnit } from "../wideEvents"
import { ThreadCaller, McpCaller } from "./McpCredentials"
import { RELAY_CLIENT_NAME, SANDBOX_RELAY_CLIENT_NAME } from "./toolAudience"

export type ToolCallOrigin = Data.TaggedEnum<{
  Sandbox: { readonly threadId: string }
  ThisDevice: {}
}>

export const ToolCallOrigin = Data.taggedEnum<ToolCallOrigin>()

export const refused = failedToolCall(
  "Glass doesn't know this Thread as the one calling, so it refused the call.",
)

const callerUnchecked = failedToolCall(
  "Glass couldn't check which Thread is calling, so it didn't run the tool. Try again.",
)

const relayClientNamed = (name: string) => {
  const initialize = {
    protocolVersion: "2025-11-25" as const,
    capabilities: new McpSchema.ClientCapabilities({}),
    clientInfo: { name, version: "1.0.0" },
  }

  // WARNING: McpServer.callTool needs a client of a session, and a relayed call has none; Glass's tools must not reach back through getClient.
  return McpSchema.McpServerClient.of({
    clientId: -1,
    protocolVersion: initialize.protocolVersion,
    clientCapabilities: initialize.capabilities,
    clientInfo: initialize.clientInfo,
    initializePayload: initialize,
    getClient: Effect.die("A Thread's Glass tool call can't reach back to its agent"),
  })
}

const relayClients = {
  ThisDevice: relayClientNamed(RELAY_CLIENT_NAME),
  Sandbox: relayClientNamed(SANDBOX_RELAY_CLIENT_NAME),
}

const visibleTo = (
  client: McpSchema.McpServerClient["Service"],
  annotations: Context.Context<never>,
) => {
  const enabledWhen = Context.getOrUndefined(annotations, McpSchema.EnabledWhen)

  return (
    enabledWhen === undefined ||
    enabledWhen({
      protocolVersion: client.protocolVersion,
      capabilities: client.clientCapabilities,
      clientInfo: client.clientInfo,
    })
  )
}

const decodeCallers = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      sandboxProvider: Schema.NullOr(Schema.String),
      forReview: Schema.BooleanFromBit,
    }),
  ),
)

export class GlassToolRelay extends Context.Service<
  GlassToolRelay,
  {
    readonly toolsFor: (origin: ToolCallOrigin) => Effect.Effect<ReadonlyArray<McpSchema.Tool>>
    readonly toolsRegistered: Effect.Effect<void>
    readonly answer: (
      origin: ToolCallOrigin,
      call: RelayedToolCall,
    ) => Effect.Effect<McpSchema.CallToolResult>
  }
>()("@glass/server/GlassToolRelay") {
  static readonly layer = Layer.effect(
    GlassToolRelay,
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer
      const sql = yield* SqlClient.SqlClient
      const registered = yield* Deferred.make<void>()

      const isLocalWork = (threadId: string) =>
        sql`
          SELECT sandbox_provider AS sandboxProvider, review_brief IS NOT NULL AS forReview
          FROM thread WHERE id = ${threadId}
        `.pipe(
          Effect.flatMap(decodeCallers),
          Effect.map(
            ([found]) => found !== undefined && found.sandboxProvider === null && !found.forReview,
          ),
        )

      const accepts = (origin: ToolCallOrigin, threadId: string) =>
        ToolCallOrigin.$match(origin, {
          Sandbox: (sandbox) => Effect.succeed(sandbox.threadId === threadId),
          ThisDevice: () => isLocalWork(threadId),
        })

      const dispatch = (origin: ToolCallOrigin, call: RelayedToolCall) =>
        server
          .callTool({
            name: call.name,
            arguments: call.arguments,
          })
          .pipe(
            Effect.provideService(
              McpCaller,
              ThreadCaller.make({ threadId: call.threadId, turnId: call.turnId }),
            ),
            Effect.provideService(McpSchema.McpServerClient, relayClients[origin._tag]),
            Effect.catchTags({
              InvalidParams: ({ message }) => Effect.succeed(failedToolCall(message)),
              InternalError: ({ message }) => Effect.succeed(failedToolCall(message)),
            }),
            Effect.withSpan("GlassToolRelay.callTool"),
          )

      return GlassToolRelay.of({
        toolsFor: (origin) =>
          Deferred.await(registered).pipe(
            Effect.andThen(
              Effect.sync(() =>
                server.tools
                  .filter(({ annotations }) => visibleTo(relayClients[origin._tag], annotations))
                  .map(({ tool }) => tool),
              ),
            ),
          ),
        toolsRegistered: Deferred.succeed(registered, undefined).pipe(Effect.asVoid),
        answer: (origin, call) =>
          Effect.gen(function* () {
            yield* annotateUnit({ tool: call.name, caller_id: call.threadId })

            const result = yield* accepts(origin, call.threadId).pipe(
              Effect.flatMap((accepted) =>
                accepted ? dispatch(origin, call) : Effect.succeed(refused),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't look up a tool's caller", cause).pipe(
                  Effect.as(callerUnchecked),
                ),
              ),
            )

            yield* annotateUnit({ tool_failed: result.isError === true })

            return result
          }).pipe(Effect.withSpan("GlassToolRelay.answer", { root: true })),
      })
    }),
  ).pipe(Layer.provide(McpServer.McpServer.layer))
}

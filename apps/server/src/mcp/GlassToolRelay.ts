import { Context, Data, Deferred, Effect, Layer, Schema } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import { SqlClient } from "effect/sql"
import { failedToolCall, type RelayedToolCall } from "../agentHost/protocol"
import { annotateUnit } from "../wideEvents"
import { ConversationCaller, McpCaller } from "./McpCredentials"

export type ToolCallOrigin = Data.TaggedEnum<{
  Sandbox: { readonly conversationId: string }
  ThisDevice: {}
}>

export const ToolCallOrigin = Data.taggedEnum<ToolCallOrigin>()

export const refused = failedToolCall(
  "Glass doesn't know this Conversation as the one calling, so it refused the call.",
)

const callerUnchecked = failedToolCall(
  "Glass couldn't check which Conversation is calling, so it didn't run the tool. Try again.",
)

const relayInitialize = {
  protocolVersion: "2025-11-25" as const,
  capabilities: new McpSchema.ClientCapabilities({}),
  clientInfo: { name: "glass-agent-host", version: "1.0.0" },
}

// WARNING: McpServer.callTool needs a client of a session, and a relayed call has none; Glass's tools must not reach back through getClient.
const relayClient = McpSchema.McpServerClient.of({
  clientId: -1,
  protocolVersion: relayInitialize.protocolVersion,
  clientCapabilities: relayInitialize.capabilities,
  clientInfo: relayInitialize.clientInfo,
  initializePayload: relayInitialize,
  getClient: Effect.die("A Conversation's Glass tool call can't reach back to its agent"),
})

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
    readonly tools: Effect.Effect<ReadonlyArray<McpSchema.Tool>>
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

      const isLocalWork = (conversationId: string) =>
        sql`
          SELECT sandbox_provider AS sandboxProvider, review_brief IS NOT NULL AS forReview
          FROM conversation WHERE id = ${conversationId}
        `.pipe(
          Effect.flatMap(decodeCallers),
          Effect.map(
            ([found]) => found !== undefined && found.sandboxProvider === null && !found.forReview,
          ),
        )

      const accepts = (origin: ToolCallOrigin, conversationId: string) =>
        ToolCallOrigin.$match(origin, {
          Sandbox: (sandbox) => Effect.succeed(sandbox.conversationId === conversationId),
          ThisDevice: () => isLocalWork(conversationId),
        })

      const dispatch = (call: RelayedToolCall) =>
        server
          .callTool({
            name: call.name,
            arguments: call.arguments,
          })
          .pipe(
            Effect.provideService(
              McpCaller,
              ConversationCaller.make({ conversationId: call.conversationId }),
            ),
            Effect.provideService(McpSchema.McpServerClient, relayClient),
            Effect.catchTags({
              InvalidParams: ({ message }) => Effect.succeed(failedToolCall(message)),
              InternalError: ({ message }) => Effect.succeed(failedToolCall(message)),
            }),
            Effect.withSpan("GlassToolRelay.callTool"),
          )

      return GlassToolRelay.of({
        tools: Deferred.await(registered).pipe(
          Effect.andThen(Effect.sync(() => server.tools.map(({ tool }) => tool))),
        ),
        toolsRegistered: Deferred.succeed(registered, undefined).pipe(Effect.asVoid),
        answer: (origin, call) =>
          Effect.gen(function* () {
            yield* annotateUnit({ tool: call.name, caller_id: call.conversationId })

            const result = yield* accepts(origin, call.conversationId).pipe(
              Effect.flatMap((accepted) => (accepted ? dispatch(call) : Effect.succeed(refused))),
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

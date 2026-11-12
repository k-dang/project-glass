import { Effect, Layer, Option, Schema } from "effect"
import { McpProtocol, McpSchema, McpServer } from "effect/ai"
import {
  HttpEffect,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { AskProgress } from "./AskProgress"
import { GlassToolHandlers, GlassTools } from "./glassTools"
import { McpCaller, McpCredentials } from "./McpCredentials"

export const MCP_PATH = "/mcp"

const SESSION_HEADER = "mcp-session-id"

const progressTokenOf = (metadata: Schema.JsonObject | undefined) =>
  Schema.decodeUnknownOption(McpSchema.ProgressToken)(metadata?.["progressToken"])

const askProgress = AskProgress.of({
  notify: (progress) =>
    Effect.gen(function* () {
      const server = yield* Effect.serviceOption(McpServer.McpServer)
      const client = yield* Effect.serviceOption(McpSchema.McpServerClient)

      const token = Option.isSome(client)
        ? progressTokenOf(client.value.requestMetadata)
        : Option.none()

      if (Option.isNone(server) || Option.isNone(token)) return

      yield* server.value.notifications["notifications/progress"]({
        progressToken: token.value,
        progress,
        message: "Waiting for an answer in the Glass Inbox",
      }).pipe(Effect.ignore)
    }),
})

const unauthorized = HttpServerResponse.empty({
  status: 401,
  headers: { "www-authenticate": "Bearer" },
})

const McpAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials

    return (httpEffect) =>
      Effect.gen(function* () {
        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
        const credential = credentials.authenticate(bearer)

        if (Option.isNone(credential)) return unauthorized

        const { caller, ownedSessions, revoked } = credential.value
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = request.headers[SESSION_HEADER]

        if (session !== undefined && !ownedSessions.has(session)) {
          return HttpServerResponse.empty({ status: 404 })
        }

        const response = yield* Effect.raceFirst(
          Effect.provideService(
            Effect.provideService(httpEffect, McpCaller, caller),
            AskProgress,
            askProgress,
          ),
          Effect.as(revoked, unauthorized),
        )

        // Effect sets an opened session's id in its own pre-response handler, so read it after.
        yield* HttpEffect.appendPreResponseHandler((_, final) =>
          Effect.sync(() => {
            const opened = final.headers[SESSION_HEADER]

            if (opened !== undefined) ownedSessions.add(opened)

            return final
          }),
        )

        return response
      })
  }),
)

const Endpoint = Layer.effectDiscard(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    const credentials = yield* McpCredentials

    yield* credentials.listening(`${HttpServer.formatAddress(address)}${MCP_PATH}`)
  }),
)

export const McpRoutes = Layer.merge(
  Endpoint,
  McpServer.layerHttp({
    name: "glass",
    version: "1.0.0",
    path: MCP_PATH,
    protocols: [McpProtocol.v2025_11_25],
    allowedOrigins: [],
    // Effect never expires sessions, so a runtime ending cleanly frees its own.
    allowSessionTermination: true,
  }).pipe(Layer.provide(McpAccess.layer), Layer.orDie),
)

export const GlassMcpTools = McpServer.toolkit(GlassTools).pipe(Layer.provide(GlassToolHandlers))

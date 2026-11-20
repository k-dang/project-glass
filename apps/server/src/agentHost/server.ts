import { Deferred, Effect, Layer, Option, type Redacted } from "effect"
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { RpcSerialization, RpcServer } from "effect/rpc"
import { RPC_PATH } from "@glass/contracts"
import { isToken } from "../access"
import { AgentHostHandlers } from "./handlers"
import { claimOpenedSession, glassMcpHttp, ownsSession } from "../mcp/mcpHttp"
import { HEALTH_PATH, HOST_TOKEN_HEADER, SHUTDOWN_PATH } from "./hostAddress"
import { HostGlassTools, RelayedConversation } from "./HostGlassTools"
import { AgentHostRpcs } from "./protocol"

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

export const portOf = (address: HttpServer.HttpServer["Service"]["address"]) =>
  Number(new URL(HttpServer.formatAddress(address)).port)

const RequireToken = (token: Redacted.Redacted) =>
  HttpRouter.middleware(
    Effect.sync(() => {
      const matches = isToken(token)

      return (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest

          return matches(request.headers[HOST_TOKEN_HEADER])
            ? yield* httpEffect
            : HttpServerResponse.text("Unauthorized", { status: 401 })
        })
    }),
  )

const RelayAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const tools = yield* HostGlassTools

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest

        if (!Option.exists(request.remoteAddress, (address) => LOOPBACK.has(address)))
          return HttpServerResponse.empty({ status: 403 })

        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
        const credential = tools.authenticate(bearer)

        if (Option.isNone(credential)) return HttpServerResponse.empty({ status: 401 })

        const { conversationId, ownedSessions } = credential.value

        if (!ownsSession(request, ownedSessions)) return HttpServerResponse.empty({ status: 404 })

        const response = yield* Effect.provideService(httpEffect, RelayedConversation, {
          conversationId,
        })

        yield* claimOpenedSession(ownedSessions)

        return response
      })
  }),
)

const ToolsEndpoint = Layer.effectDiscard(
  Effect.gen(function* () {
    const { address } = yield* HttpServer.HttpServer
    const tools = yield* HostGlassTools

    yield* tools.listening(portOf(address))
  }),
)

export const hostServer = (options: {
  readonly token: Redacted.Redacted
  readonly shutDown: Deferred.Deferred<void>
}) =>
  HttpRouter.serve(
    Layer.mergeAll(
      Layer.merge(
        RpcServer.layerHttp({ group: AgentHostRpcs, path: RPC_PATH, protocol: "websocket" }),
        HttpRouter.add(
          "POST",
          SHUTDOWN_PATH,
          Deferred.succeed(options.shutDown, undefined).pipe(
            // WARNING: This request is still open when the server starts closing, so Node won't close its connection as idle.
            Effect.as(HttpServerResponse.empty({ headers: { connection: "close" } })),
          ),
        ),
      ).pipe(Layer.provide(RequireToken(options.token).layer)),
      glassMcpHttp().pipe(Layer.provide(RelayAccess.layer), Layer.orDie),
      HttpRouter.add("GET", HEALTH_PATH, HttpServerResponse.text("ok")),
      ToolsEndpoint,
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(Layer.provide(AgentHostHandlers), Layer.provide(RpcSerialization.layerJson))

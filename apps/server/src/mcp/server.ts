import { Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { McpCaller, McpCredentials } from "./McpCredentials"

export const MCP_PATH = "/mcp"

const SESSION_HEADER = "mcp-session-id"

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
          Effect.provideService(httpEffect, McpCaller, caller),
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

export const McpRoutes = (tools: Layer.Layer<never>) =>
  Layer.merge(
    McpServer.layerHttp({
      name: "glass",
      version: "1.0.0",
      path: MCP_PATH,
      protocols: [McpProtocol.v2025_11_25],
      allowedOrigins: [],
      // Effect never expires sessions, so a runtime ending cleanly frees its own.
      allowSessionTermination: true,
    }).pipe(Layer.provide(McpAccess.layer), Layer.orDie),
    tools,
  )

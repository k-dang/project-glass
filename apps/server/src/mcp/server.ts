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

// Each request authenticates on its own, and its caller comes from its credential. A session
// belongs to the credential that opened it: another credential gets the 404 of an unknown session.
// Revoking a credential ends its requests still in flight, which interrupts their tool calls.
const McpAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials

    return (httpEffect) =>
      Effect.gen(function* () {
        // Effect's own bearer decoder, which keeps the value redacted.
        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
        const credential = credentials.authenticate(bearer)

        if (Option.isNone(credential)) return unauthorized

        const { caller, sessions, revoked } = credential.value
        const request = yield* HttpServerRequest.HttpServerRequest
        const session = request.headers[SESSION_HEADER]

        if (session !== undefined && !sessions.has(session)) {
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

            if (opened !== undefined) sessions.add(opened)

            return final
          }),
        )

        return response
      })
  }),
)

/**
 * Glass's MCP endpoint for conversation runtimes, on the backend's listener beside the renderer's
 * RPC. It authenticates with `McpCredentials` instead of the renderer's launch secret.
 * `McpServer.layerHttp` refuses any request with an `Origin` header, keeping browser pages out.
 */
export const McpRoutes = (tools: Layer.Layer<never>) =>
  Layer.merge(
    McpServer.layerHttp({
      name: "glass",
      version: "1.0.0",
      path: MCP_PATH,
      protocols: [McpProtocol.v2025_11_25],
      // Effect never expires sessions: a runtime ending cleanly frees its own. A revoked
      // credential's sessions are unusable but stay in Effect's memory until the backend restarts.
      allowSessionTermination: true,
    }).pipe(Layer.provide(McpAccess.layer), Layer.orDie),
    tools,
  )

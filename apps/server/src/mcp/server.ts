import { Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpRouter, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { McpCaller, McpCredentials } from "./McpCredentials"

export const MCP_PATH = "/mcp"

// Each request authenticates on its own: an MCP session id only correlates requests, so the caller
// comes from the bearer every time. A missing, wrong or revoked credential gets the same 401.
const McpAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials

    return (httpEffect) =>
      Effect.gen(function* () {
        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
        const caller = credentials.authenticate(bearer)

        if (Option.isNone(caller)) {
          return HttpServerResponse.empty({
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          })
        }

        return yield* Effect.provideService(httpEffect, McpCaller, caller.value)
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
      // The session map has no expiry; a client ending its runtime frees its session.
      allowSessionTermination: true,
    }).pipe(Layer.provide(McpAccess.layer), Layer.orDie),
    tools,
  )

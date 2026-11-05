import { Effect, Layer, Option } from "effect"
import { McpProtocol, McpServer } from "effect/ai"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { McpCaller, McpCredentials } from "./McpCredentials"

export const MCP_PATH = "/mcp"

const BEARER = /^Bearer (\S+)$/i

// Each request authenticates on its own: an MCP session id only correlates requests, so the caller
// comes from the bearer every time. A missing, wrong or revoked credential gets the same 401.
const McpAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const bearer = request.headers["authorization"]?.match(BEARER)?.[1]
        const caller = bearer === undefined ? Option.none() : credentials.authenticate(bearer)

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
    }).pipe(Layer.provide(McpAccess.layer), Layer.orDie),
    tools,
  )

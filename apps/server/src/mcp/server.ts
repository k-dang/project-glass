import { Effect, Layer, Option, Predicate, Redacted, Stream } from "effect"
import { McpServer } from "effect/ai"
import {
  HttpBody,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { OutsideAgents } from "../OutsideAgents"
import { GlassToolHandlers, GlassTools } from "./glassTools"
import { GlassToolRelay } from "./GlassToolRelay"
import { BrowserMcpTools } from "./browserTools"
import { VisualizationToolHandlers, VisualizationTools } from "./visualizationTools"
import { McpCaller, McpCredentials } from "./McpCredentials"
import { claimOpenedSession, glassMcpHttp, MCP_PATH, ownsSession } from "./mcpHttp"
import { requestUrls } from "./McpOAuth"

const challenge = (issuer: string, presented: boolean) => {
  const metadata = `${issuer}/.well-known/oauth-protected-resource/mcp`
  const params = [`resource_metadata="${metadata}"`]

  if (presented) params.push(`error="invalid_token"`)

  return HttpServerResponse.empty({
    status: 401,
    headers: { "www-authenticate": `Bearer ${params.join(", ")}` },
  })
}

const endStreamOnRevoke = (
  response: HttpServerResponse.HttpServerResponse,
  revoked: Effect.Effect<void>,
) => {
  if (!Predicate.isTagged(response.body, "Stream")) return response

  const { stream, contentType, contentLength } = response.body

  return HttpServerResponse.setBody(
    response,
    HttpBody.stream(Stream.interruptWhen(stream, revoked), contentType, contentLength),
  )
}

const McpAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const credentials = yield* McpCredentials
    const outsideAgents = yield* OutsideAgents

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const urls = requestUrls(request)

        if (urls === undefined) {
          return HttpServerResponse.empty({
            status: 401,
            headers: { "www-authenticate": "Bearer" },
          })
        }

        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)
        const issued = credentials.authenticate(bearer)

        const credential = Option.isSome(issued)
          ? issued
          : yield* outsideAgents.authenticate(bearer)

        if (Option.isNone(credential)) {
          return challenge(urls.issuer, Redacted.value(bearer) !== "")
        }

        const { caller, ownedSessions, revoked } = credential.value

        if (!ownsSession(request, ownedSessions)) return HttpServerResponse.empty({ status: 404 })

        const response = yield* Effect.raceFirst(
          Effect.provideService(httpEffect, McpCaller, caller),
          Effect.as(revoked, challenge(urls.issuer, true)),
        )

        yield* claimOpenedSession(ownedSessions)

        return endStreamOnRevoke(response, revoked)
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
  glassMcpHttp().pipe(Layer.provide(McpAccess.layer), Layer.orDie),
)

export const GlassMcpTools = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* (yield* GlassToolRelay).toolsRegistered
  }),
).pipe(
  Layer.provide(BrowserMcpTools),
  Layer.provide(McpServer.toolkit(VisualizationTools)),
  Layer.provide(VisualizationToolHandlers),
  Layer.provide(McpServer.toolkit(GlassTools)),
  Layer.provide(GlassToolHandlers),
)

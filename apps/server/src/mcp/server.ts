import { Effect, Layer, Option, Predicate, Redacted, Schema, Stream } from "effect"
import { McpSchema, McpServer } from "effect/ai"
import {
  HttpBody,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { OutsideAgents } from "../OutsideAgents"
import { AskProgress } from "./AskProgress"
import { GlassToolHandlers, GlassTools } from "./glassTools"
import { GlassToolRelay } from "./GlassToolRelay"
import { BrowserMcpTools } from "./browserTools"
import { VisualizationToolHandlers, VisualizationTools } from "./visualizationTools"
import { McpCaller, McpCredentials, OutsideAgentCaller } from "./McpCredentials"
import { claimOpenedSession, glassMcpHttp, MCP_PATH, ownsSession, SESSION_HEADER } from "./mcpHttp"
import { requestUrls } from "./McpOAuth"

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

        const session = request.headers[SESSION_HEADER]

        const calling =
          Predicate.isTagged(caller, "OutsideAgent") && session !== undefined
            ? new OutsideAgentCaller({
                agentId: caller.agentId,
                name: caller.name,
                session,
              })
            : caller

        const response = yield* Effect.raceFirst(
          Effect.provideService(
            Effect.provideService(httpEffect, McpCaller, calling),
            AskProgress,
            askProgress,
          ),
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

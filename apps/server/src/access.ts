import { TOKEN_PARAM } from "@glass/contracts"
import { Effect, Option, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiSecurity } from "effect/http-api"
import { timingSafeEqual } from "node:crypto"
import { OutsideAgents } from "./OutsideAgents"
import { ServerConfig } from "./ServerConfig"

export const isToken = (token: Redacted.Redacted) => {
  const expected = Buffer.from(Redacted.value(token))

  return (candidate: string | null | undefined) => {
    const given = Buffer.from(candidate ?? "")

    return given.length === expected.length && timingSafeEqual(given, expected)
  }
}

const carriesToken = (token: Redacted.Redacted) => {
  const matches = isToken(token)

  return (url: URL) => matches(url.searchParams.get(TOKEN_PARAM))
}

export const RendererAccess = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const outsideAgents = yield* OutsideAgents
    const hasToken = carriesToken(config.token)

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const bearer = yield* HttpApiBuilder.securityDecode(HttpApiSecurity.bearer)

        // An outside-agent token is not a launched conversation, even with the launch token beside it.
        if (Redacted.value(bearer) !== "") {
          const outside = yield* outsideAgents.authenticate(bearer)

          if (Option.isSome(outside)) {
            return HttpServerResponse.text(
              "MCP client sessions are only accepted by the MCP endpoint.",
              { status: 401 },
            )
          }
        }

        const url = new URL(request.url, "http://127.0.0.1")

        if (!hasToken(url)) {
          return HttpServerResponse.text("Unauthorized", { status: 401 })
        }

        const origin = request.headers["origin"]

        if (origin === undefined || config.allowedOrigins.has(origin)) {
          return yield* httpEffect
        }

        return HttpServerResponse.text("Forbidden origin", { status: 403 })
      })
  }),
)

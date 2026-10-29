import { TOKEN_PARAM } from "@glass/contracts"
import { Effect, Redacted } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { timingSafeEqual } from "node:crypto"
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

export const AccessControl = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* ServerConfig
    const hasToken = carriesToken(config.token)

    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
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
  { global: true },
)

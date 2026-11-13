import { Clock, Context, Effect, FileSystem, Layer, Option, Ref, Schema } from "effect"
import type { HttpServerRequest } from "effect/http"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { join } from "node:path"
import { writeDataFile } from "../dataFiles"
import { mintBearer, sameSecret } from "./McpCredentials"
import { ServerConfig } from "../ServerConfig"

// Registration is a signed client id, so an open register endpoint cannot fill the database.
// Glass listens on 127.0.0.1. The issuer is that bound address, and a request is accepted only
// when its Host is a loopback name on that same port.

const SIGNING_KEY = "mcp-oauth.key"

const CODE_TTL_MS = 60_000

const MAX_CLIENT_NAME_LENGTH = 100

const MAX_REDIRECT_URIS = 5

const MAX_REDIRECT_URI_LENGTH = 512

const DEFAULT_CLIENT_NAME = "MCP client"

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

/** Host names as `URL.hostname` spells them, so IPv6 keeps its brackets. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

const ClientIdPayload = Schema.Struct({
  v: Schema.Literal(1),
  n: Schema.String,
  r: Schema.Array(Schema.String),
})

const decodeClientIdPayload = Schema.decodeUnknownOption(Schema.fromJsonString(ClientIdPayload))

export interface OAuthUrls {
  readonly issuer: string
  readonly resource: string
}

const hostNameAndPort = (host: string): { name: string; port: string } | undefined => {
  if (host.startsWith("[")) {
    const end = host.indexOf("]")

    if (end <= 1 || !host.slice(end + 1).startsWith(":")) return undefined

    return { name: host.slice(0, end + 1), port: host.slice(end + 2) }
  }

  const colon = host.lastIndexOf(":")

  if (colon <= 0) return undefined

  return { name: host.slice(0, colon), port: host.slice(colon + 1) }
}

const decodeLocalPort = Schema.decodeUnknownOption(
  Schema.Struct({ socket: Schema.Struct({ localPort: Schema.Number }) }),
)

/**
 * The issuer and resource for a request whose Host is a loopback name on the port it arrived on,
 * which Glass may have asked the OS to choose.
 */
export const requestUrls = (
  request: HttpServerRequest.HttpServerRequest,
): OAuthUrls | undefined => {
  const decoded = decodeLocalPort(request.source)
  const host = request.headers.host

  if (Option.isNone(decoded) || host === undefined) return undefined

  const port = decoded.value.socket.localPort
  const parts = hostNameAndPort(host.trim())

  if (port <= 0 || parts === undefined || parts.port !== String(port)) return undefined

  if (!LOOPBACK_HOSTS.has(parts.name.toLowerCase())) return undefined

  const issuer = `http://127.0.0.1:${port}`

  return { issuer, resource: `${issuer}/mcp` }
}

export const protectedResourceMetadata = (urls: OAuthUrls) => ({
  resource: urls.resource,
  authorization_servers: [urls.issuer],
  bearer_methods_supported: ["header"],
  resource_name: "Glass",
})

export const authorizationServerMetadata = (urls: OAuthUrls) => ({
  issuer: urls.issuer,
  authorization_endpoint: `${urls.issuer}/oauth/mcp/authorize`,
  token_endpoint: `${urls.issuer}/oauth/mcp/token`,
  registration_endpoint: `${urls.issuer}/oauth/mcp/register`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code"],
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none"],
  authorization_response_iss_parameter_supported: true,
})

const parseRedirect = (value: string): URL | undefined => {
  if (value.length > MAX_REDIRECT_URI_LENGTH || value.includes("#")) return undefined

  try {
    const url = new URL(value)

    const allowed = url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)

    return allowed && url.username === "" && url.password === "" ? url : undefined
  } catch {
    return undefined
  }
}

const redirectMatches = (registered: string, presented: string) => {
  const left = parseRedirect(registered)
  const right = parseRedirect(presented)

  if (left === undefined || right === undefined) return false

  return (
    left.hostname === right.hostname &&
    left.pathname === right.pathname &&
    left.search === right.search
  )
}

const sameResource = (urls: OAuthUrls, presented: string | undefined) => {
  if (presented === undefined || presented === "") return true

  try {
    const url = new URL(presented)

    return url.hash === "" && `${url.origin}${url.pathname.replace(/\/+$/u, "")}` === urls.resource
  } catch {
    return false
  }
}

const redirectWith = (redirectUri: string, params: Record<string, string | undefined>) => {
  const url = new URL(redirectUri)

  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(name, value)
  }

  return url.toString()
}

export class OAuthPageError extends Schema.TaggedError<OAuthPageError>()("OAuthPageError", {
  description: Schema.String,
}) {}

export class OAuthRedirectError extends Schema.TaggedError<OAuthRedirectError>()(
  "OAuthRedirectError",
  {
    error: Schema.Literals(["invalid_request", "unsupported_response_type", "invalid_target"]),
    description: Schema.String,
    redirectUri: Schema.String,
    state: Schema.String,
  },
) {}

export class OAuthRegistrationError extends Schema.TaggedError<OAuthRegistrationError>()(
  "OAuthRegistrationError",
  {
    error: Schema.Literals(["invalid_redirect_uri", "invalid_client_metadata"]),
    description: Schema.String,
  },
) {}

export class OAuthTokenError extends Schema.TaggedError<OAuthTokenError>()("OAuthTokenError", {
  error: Schema.Literals([
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unsupported_grant_type",
  ]),
  description: Schema.String,
}) {}

export interface AuthorizationQuery {
  readonly client_id: string | undefined
  readonly redirect_uri: string | undefined
  readonly response_type: string | undefined
  readonly code_challenge: string | undefined
  readonly code_challenge_method: string | undefined
  readonly state: string | undefined
  readonly resource: string | undefined
}

export interface Authorization {
  readonly clientId: string
  readonly name: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly state: string
  readonly issuer: string
  readonly resource: string
}

export interface RegisteredClient {
  readonly clientId: string
  readonly name: string
  readonly redirectUris: ReadonlyArray<string>
}

interface PendingCode {
  readonly clientId: string
  readonly name: string
  readonly redirectUri: string
  readonly codeChallenge: string
  readonly resource: string
  readonly expiresAt: number
}

export type CsrfFields = Pick<
  Authorization,
  "clientId" | "redirectUri" | "codeChallenge" | "state" | "resource"
>

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;"
      case "<":
        return "&lt;"
      case ">":
        return "&gt;"
      case '"':
        return "&quot;"
      case "'":
        return "&#39;"
      default:
        return char
    }
  })

const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`

export const renderError = (description: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glass couldn't connect that app</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1c1915; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { width: min(32rem, calc(100% - 2rem)); }
  h1 { font-size: 1.4rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { margin: 0; }
</style>
</head>
<body>
<main>
  <h1>Glass couldn't connect that app</h1>
  <p>${escapeHtml(description)}</p>
</main>
</body>
</html>`

export const renderApproval = (authorization: Authorization, csrf: string) => {
  const name = escapeHtml(authorization.name)
  const host = escapeHtml(new URL(authorization.redirectUri).host)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${name} to Glass</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1c1915; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { width: min(34rem, calc(100% - 2rem)); }
  h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
  p { margin: 0 0 0.75rem; }
  form { display: flex; gap: 0.75rem; margin-top: 1.25rem; }
  button { font: inherit; border-radius: 0.6rem; padding: 0.55rem 1rem; cursor: pointer; }
  button[value="approve"] { background: #1c1915; color: #f6f5f2; border: 1px solid #1c1915; }
  button[value="deny"] { background: transparent; color: #1c1915; border: 1px solid #c9c4bb; }
</style>
</head>
<body>
<main>
  <h1>${name} wants to connect</h1>
  <p>${name} will be able to read your pull requests, to-dos, and agents, start and message agents, start a review, and ask you a question in the Inbox. The connection lasts 30 days. You can disconnect it in Settings.</p>
  <p>Glass sends this approval back to <strong>${host}</strong>. Approve only a sign-in you just started.</p>
  <form method="post" action="/oauth/mcp/decision">
    ${hidden("client_id", authorization.clientId)}
    ${hidden("redirect_uri", authorization.redirectUri)}
    ${hidden("code_challenge", authorization.codeChallenge)}
    ${hidden("state", authorization.state)}
    ${hidden("resource", authorization.resource)}
    ${hidden("csrf", csrf)}
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </form>
</main>
</body>
</html>`
}

export const redirectForError = (error: OAuthRedirectError, issuer: string) =>
  redirectWith(error.redirectUri, {
    error: error.error,
    error_description: error.description,
    state: error.state,
    iss: issuer,
  })

const tokenError = (error: OAuthTokenError["error"], description: string) =>
  new OAuthTokenError({ error, description })

const pkceMatches = (verifier: string, challenge: string) => {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false

  return sameSecret(createHash("sha256").update(verifier).digest("base64url"), challenge)
}

export class McpOAuth extends Context.Service<
  McpOAuth,
  {
    readonly register: (input: {
      readonly clientName: string | undefined
      readonly redirectUris: ReadonlyArray<string>
    }) => Effect.Effect<RegisteredClient, OAuthRegistrationError>
    readonly validateAuthorization: (input: {
      readonly urls: OAuthUrls
      readonly request: AuthorizationQuery
    }) => Effect.Effect<Authorization, OAuthPageError | OAuthRedirectError>
    readonly csrfMatches: (fields: CsrfFields, given: string) => boolean
    readonly csrfFor: (fields: CsrfFields) => string
    readonly approve: (authorization: Authorization) => Effect.Effect<string>
    readonly deny: (authorization: Authorization) => string
    readonly exchange: (input: {
      readonly urls: OAuthUrls
      readonly grantType: string | undefined
      readonly code: string | undefined
      readonly redirectUri: string | undefined
      readonly clientId: string | undefined
      readonly verifier: string | undefined
      readonly resource: string | undefined
    }) => Effect.Effect<{ readonly name: string }, OAuthTokenError>
  }
>()("@glass/server/McpOAuth") {
  static readonly layer = Layer.effect(
    McpOAuth,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { dataDirectory } = yield* ServerConfig
      const keyPath = join(dataDirectory, SIGNING_KEY)

      const stored = yield* fs.readFileString(keyPath).pipe(
        Effect.map(Option.some),
        Effect.catchReason("PlatformError", "NotFound", () =>
          Effect.succeed(Option.none<string>()),
        ),
      )

      const key = Option.isSome(stored)
        ? Buffer.from(stored.value.trim(), "base64")
        : randomBytes(32)

      if (key.length !== 32) {
        return yield* Effect.die("The MCP OAuth signing key is not 32 bytes.")
      }

      if (Option.isNone(stored)) yield* writeDataFile(fs, keyPath, key.toString("base64"))

      const codes = yield* Ref.make(new Map<string, PendingCode>())

      const sign = (purpose: string, value: string) =>
        createHmac("sha256", key).update(`${purpose}.${value}`).digest("base64url")

      const csrfFor = (fields: CsrfFields) =>
        sign(
          "mcp-csrf",
          JSON.stringify([
            fields.clientId,
            fields.redirectUri,
            fields.codeChallenge,
            fields.state,
            fields.resource,
          ]),
        )

      const parseClientId = (clientId: string): RegisteredClient | undefined => {
        const dot = clientId.lastIndexOf(".")

        if (dot <= 0) return undefined

        const body = clientId.slice(0, dot)
        const signature = clientId.slice(dot + 1)

        if (!sameSecret(sign("mcp-client-id", body), signature)) return undefined

        const payload = decodeClientIdPayload(Buffer.from(body, "base64url").toString("utf8"))

        if (Option.isNone(payload)) return undefined

        return {
          clientId,
          name: payload.value.n,
          redirectUris: payload.value.r,
        }
      }

      const register = (input: {
        readonly clientName: string | undefined
        readonly redirectUris: ReadonlyArray<string>
      }) =>
        Effect.gen(function* () {
          const trimmed = input.clientName?.trim() ?? ""

          const name = (trimmed.length > 0 ? trimmed : DEFAULT_CLIENT_NAME).slice(
            0,
            MAX_CLIENT_NAME_LENGTH,
          )

          const redirectUris = input.redirectUris

          if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
            return yield* new OAuthRegistrationError({
              error: "invalid_redirect_uri",
              description: `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`,
            })
          }

          if (!redirectUris.every((uri) => parseRedirect(uri) !== undefined)) {
            return yield* new OAuthRegistrationError({
              error: "invalid_redirect_uri",
              description: "Redirect URIs must be http on localhost, 127.0.0.1, or [::1].",
            })
          }

          const body = Buffer.from(
            JSON.stringify({ v: 1, n: name, r: redirectUris }),
            "utf8",
          ).toString("base64url")

          return {
            clientId: `${body}.${sign("mcp-client-id", body)}`,
            name,
            redirectUris,
          }
        })

      const validateAuthorization = (input: {
        readonly urls: OAuthUrls
        readonly request: AuthorizationQuery
      }) =>
        Effect.gen(function* () {
          const client = parseClientId(input.request.client_id ?? "")

          if (client === undefined) {
            return yield* new OAuthPageError({
              description:
                "This sign-in link names an unknown app. Start the sign-in again from it.",
            })
          }

          const redirectUri = input.request.redirect_uri

          if (
            redirectUri === undefined ||
            !client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
          ) {
            return yield* new OAuthPageError({
              description: "This sign-in link sends you to an address the app did not register.",
            })
          }

          const state = input.request.state ?? ""

          const fail = (error: OAuthRedirectError["error"], description: string) =>
            new OAuthRedirectError({
              error,
              description,
              redirectUri,
              state,
            })

          if (input.request.response_type !== "code") {
            return yield* fail("unsupported_response_type", "Only response_type=code is supported.")
          }

          const codeChallenge = input.request.code_challenge

          if (
            input.request.code_challenge_method !== "S256" ||
            codeChallenge === undefined ||
            !CODE_CHALLENGE.test(codeChallenge)
          ) {
            return yield* fail(
              "invalid_request",
              "PKCE with code_challenge_method=S256 is required.",
            )
          }

          if (!sameResource(input.urls, input.request.resource)) {
            return yield* fail(
              "invalid_target",
              `This server only issues tokens for ${input.urls.resource}.`,
            )
          }

          return {
            clientId: client.clientId,
            name: client.name,
            redirectUri,
            codeChallenge,
            state,
            issuer: input.urls.issuer,
            resource: input.urls.resource,
          } satisfies Authorization
        })

      const approve = (authorization: Authorization) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const code = mintBearer()

          yield* Ref.update(codes, (current) => {
            const next = new Map([...current].filter(([, pending]) => pending.expiresAt > now))

            next.set(code, {
              clientId: authorization.clientId,
              name: authorization.name,
              redirectUri: authorization.redirectUri,
              codeChallenge: authorization.codeChallenge,
              resource: authorization.resource,
              expiresAt: now + CODE_TTL_MS,
            })

            return next
          })

          return redirectWith(authorization.redirectUri, {
            code,
            state: authorization.state,
            iss: authorization.issuer,
          })
        })

      const exchange = (input: {
        readonly urls: OAuthUrls
        readonly grantType: string | undefined
        readonly code: string | undefined
        readonly redirectUri: string | undefined
        readonly clientId: string | undefined
        readonly verifier: string | undefined
        readonly resource: string | undefined
      }) =>
        Effect.gen(function* () {
          if (input.grantType !== "authorization_code") {
            return yield* tokenError(
              "unsupported_grant_type",
              "Only authorization_code is supported.",
            )
          }

          const { code, redirectUri, clientId, verifier } = input

          if (
            code === undefined ||
            redirectUri === undefined ||
            clientId === undefined ||
            verifier === undefined
          ) {
            return yield* tokenError(
              "invalid_request",
              "code, redirect_uri, client_id, and code_verifier are required.",
            )
          }

          if (parseClientId(clientId) === undefined) {
            return yield* tokenError("invalid_client", "The client is unknown.")
          }

          // A presented code is spent even when a later check fails (RFC 6749).
          const pending = yield* Ref.modify(codes, (current) => {
            const found = current.get(code)

            if (found === undefined) return [undefined, current] as const

            const next = new Map(current)

            next.delete(code)

            return [found, next] as const
          })

          const now = yield* Clock.currentTimeMillis

          if (
            pending === undefined ||
            pending.expiresAt <= now ||
            pending.clientId !== clientId ||
            pending.redirectUri !== redirectUri ||
            pending.resource !== input.urls.resource ||
            !sameResource(input.urls, input.resource) ||
            !pkceMatches(verifier, pending.codeChallenge)
          ) {
            return yield* tokenError(
              "invalid_grant",
              "The authorization code is invalid or expired.",
            )
          }

          return { name: pending.name }
        })

      return McpOAuth.of({
        register,
        validateAuthorization,
        csrfFor,
        csrfMatches: (fields, given) => sameSecret(csrfFor(fields), given),
        approve,
        deny: (authorization) =>
          redirectWith(authorization.redirectUri, {
            error: "access_denied",
            state: authorization.state,
            iss: authorization.issuer,
          }),
        exchange,
      })
    }),
  )
}

import {
  type OutsideAgentDecision,
  OutsideAgentRequest,
  OutsideAgentRequestNotWaiting,
} from "@glass/contracts"
import {
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import type { HttpServerRequest } from "effect/http"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import { join } from "node:path"
import { writeDataFile } from "../dataFiles"
import { mintBearer, timingSafeSameSecret } from "./McpCredentials"
import { ServerConfig } from "../ServerConfig"

const SIGNING_KEY = "mcp-oauth.key"

const CODE_TTL_MS = 60_000

export const REQUEST_TTL = Duration.minutes(10)

export const MAX_WAITING_REQUESTS = 5

const DECISION_POLL_SECONDS = 1

const MAX_CLIENT_NAME_LENGTH = 100

const MAX_REDIRECT_URIS = 5

const MAX_REDIRECT_URI_LENGTH = 512

const DEFAULT_CLIENT_NAME = "MCP client"

const CODE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/

// WARNING: URL.hostname keeps IPv6 brackets, so "[::1]" is spelled with them.
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

class OAuthRegistrationError extends Schema.TaggedError<OAuthRegistrationError>()(
  "OAuthRegistrationError",
  {
    error: Schema.Literals(["invalid_redirect_uri", "invalid_client_metadata"]),
    description: Schema.String,
  },
) {}

class OAuthTokenError extends Schema.TaggedError<OAuthTokenError>()("OAuthTokenError", {
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

interface RegisteredClient {
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

interface WaitingRequest {
  readonly request: OutsideAgentRequest
  readonly authorization: Authorization
  readonly expiresAt: number
}

interface DecidedRequest extends WaitingRequest {
  readonly decision: OutsideAgentDecision
}

interface Requests {
  readonly waiting: ReadonlyArray<WaitingRequest>
  readonly decided: ReadonlyArray<DecidedRequest>
}

const soonestExpiry = ({ waiting, decided }: Requests) =>
  Math.min(
    ...waiting.map(({ expiresAt }) => expiresAt),
    ...decided.map(({ expiresAt }) => expiresAt),
  )

type Found = readonly [DecidedRequest | undefined, WaitingRequest | undefined]

export type CollectedDecision = Data.TaggedEnum<{
  Waiting: { readonly request: OutsideAgentRequest }
  Decided: { readonly redirect: string }
}>

const CollectedDecision = Data.taggedEnum<CollectedDecision>()

const sameAuthorization = (a: Authorization, b: Authorization) =>
  a.clientId === b.clientId &&
  a.redirectUri === b.redirectUri &&
  a.codeChallenge === b.codeChallenge &&
  a.state === b.state &&
  a.issuer === b.issuer &&
  a.resource === b.resource

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

export const renderWaiting = (request: OutsideAgentRequest) => {
  const name = escapeHtml(request.name)
  const host = escapeHtml(request.redirectHost)
  const next = escapeHtml(`/oauth/mcp/decision?request=${encodeURIComponent(request.id)}`)

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${DECISION_POLL_SECONDS};url=${next}">
<title>Approve ${name} in Glass</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f5f2; color: #1c1915; font: 16px/1.5 ui-sans-serif, system-ui, sans-serif; }
  main { width: min(34rem, calc(100% - 2rem)); }
  h1 { font-size: 1.5rem; font-weight: 600; letter-spacing: -0.02em; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
  p { margin: 0 0 0.75rem; }
</style>
</head>
<body>
<main>
  <h1>Approve ${name} in Glass</h1>
  <p>${name} is asking to connect. Open Glass and answer it in the Inbox. This page carries on once you approve or deny it.</p>
  <p>Glass sends the approval back to <strong>${host}</strong>. Approve only a sign-in you just started.</p>
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

const deny = (authorization: Authorization) =>
  redirectWith(authorization.redirectUri, {
    error: "access_denied",
    state: authorization.state,
    iss: authorization.issuer,
  })

const tokenError = (error: OAuthTokenError["error"], description: string) =>
  new OAuthTokenError({ error, description })

const pkceMatches = (verifier: string, challenge: string) => {
  if (!CODE_VERIFIER.test(verifier) || !CODE_CHALLENGE.test(challenge)) return false

  return timingSafeSameSecret(createHash("sha256").update(verifier).digest("base64url"), challenge)
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
    readonly open: (authorization: Authorization) => Effect.Effect<OutsideAgentRequest>
    readonly answer: (
      id: string,
      decision: OutsideAgentDecision,
    ) => Effect.Effect<void, OutsideAgentRequestNotWaiting>
    readonly collect: (id: string) => Effect.Effect<CollectedDecision, OAuthPageError>
    readonly watchRequests: () => Stream.Stream<ReadonlyArray<OutsideAgentRequest>>
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

      const scope = yield* Scope.Scope
      const codes = yield* Ref.make(new Map<string, PendingCode>())
      const requests = yield* SubscriptionRef.make<Requests>({ waiting: [], decided: [] })

      const sign = (purpose: string, value: string) =>
        createHmac("sha256", key).update(`${purpose}.${value}`).digest("base64url")

      const parseClientId = (clientId: string): RegisteredClient | undefined => {
        const dot = clientId.lastIndexOf(".")

        if (dot <= 0) return undefined

        const body = clientId.slice(0, dot)
        const signature = clientId.slice(dot + 1)

        if (!timingSafeSameSecret(sign("mcp-client-id", body), signature)) return undefined

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

      const expireThrough = (at: number) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis

          yield* Effect.sleep(Math.max(0, at - now))
          yield* SubscriptionRef.update(requests, ({ waiting, decided }) => ({
            waiting: waiting.filter((entry) => entry.expiresAt > at),
            decided: decided.filter((entry) => entry.expiresAt > at),
          }))
        })

      yield* SubscriptionRef.changes(requests).pipe(
        Stream.map(soonestExpiry),
        Stream.changes,
        Stream.switchMap((at) =>
          Number.isFinite(at) ? Stream.fromEffect(expireThrough(at)) : Stream.empty,
        ),
        Stream.runDrain,
        Effect.forkIn(scope),
      )

      const open = (authorization: Authorization) =>
        Effect.gen(function* () {
          const since = yield* DateTime.now

          const created = OutsideAgentRequest.make({
            id: randomUUID(),
            name: authorization.name,
            redirectHost: new URL(authorization.redirectUri).host,
            since,
          })

          const expiresAt = DateTime.toEpochMillis(since) + Duration.toMillis(REQUEST_TTL)

          return yield* SubscriptionRef.modify(requests, (state) => {
            const same = state.waiting.find((entry) =>
              sameAuthorization(entry.authorization, authorization),
            )

            if (same !== undefined) return [same.request, state] as const

            const waiting = [...state.waiting, { request: created, authorization, expiresAt }]

            return [created, { ...state, waiting: waiting.slice(-MAX_WAITING_REQUESTS) }] as const
          })
        })

      const answer = (id: string, decision: OutsideAgentDecision) =>
        SubscriptionRef.modify(requests, (state) => {
          const found = state.waiting.find((entry) => entry.request.id === id)

          return found === undefined
            ? ([false, state] as const)
            : ([
                true,
                {
                  waiting: state.waiting.filter((entry) => entry !== found),
                  decided: [...state.decided, { ...found, decision }],
                },
              ] as const)
        }).pipe(
          Effect.flatMap((answered) =>
            answered ? Effect.void : Effect.fail(new OutsideAgentRequestNotWaiting()),
          ),
        )

      const collect = (id: string) =>
        Effect.gen(function* () {
          const [decided, waiting] = yield* SubscriptionRef.modify(
            requests,
            (state): readonly [Found, Requests] => {
              const found = state.decided.find((entry) => entry.request.id === id)

              return found === undefined
                ? ([
                    [undefined, state.waiting.find((entry) => entry.request.id === id)],
                    state,
                  ] as const)
                : ([
                    [found, undefined],
                    { ...state, decided: state.decided.filter((entry) => entry !== found) },
                  ] as const)
            },
          )

          if (decided !== undefined) {
            const redirect =
              decided.decision === "approve"
                ? yield* approve(decided.authorization)
                : deny(decided.authorization)

            return CollectedDecision.Decided({ redirect })
          }

          if (waiting === undefined) {
            return yield* new OAuthPageError({
              description: "This sign-in has ended. Start it again from the app.",
            })
          }

          return CollectedDecision.Waiting({ request: waiting.request })
        })

      return McpOAuth.of({
        register,
        validateAuthorization,
        open,
        answer,
        collect,
        watchRequests: () =>
          SubscriptionRef.changes(requests).pipe(
            Stream.map(({ waiting }) => waiting),
            Stream.changesWith((a, b) => a === b),
            Stream.map((waiting) => waiting.map(({ request }) => request)),
          ),
        exchange,
      })
    }),
  )
}

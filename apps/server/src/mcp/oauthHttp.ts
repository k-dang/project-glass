import { DateTime, Effect, Layer, Match, Option, Redacted, Result, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse, UrlParams } from "effect/http"
import { OUTSIDE_AGENT_TTL, OutsideAgents } from "../OutsideAgents"
import {
  authorizationServerMetadata,
  McpOAuth,
  OAuthPageError,
  OAuthRedirectError,
  type OAuthUrls,
  protectedResourceMetadata,
  redirectForError,
  renderApproval,
  renderError,
  boundPort,
  urlsFromHost,
  type AuthorizationQuery,
} from "./McpOAuth"

// form-action has to name loopback hosts, not only 'self'. This page asks the
// browser not to send a referrer, Chrome then treats the page's origin as
// null, and 'self' no longer matches the form. The redirect after approval is
// the client's own loopback address, which is also not 'self'.
const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' http://127.0.0.1:* http://localhost:* http://[::1]:*; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
}

const NO_STORE = { "cache-control": "no-store", pragma: "no-cache" }

const REDIRECT_HEADERS = { "referrer-policy": "no-referrer", "cache-control": "no-store" }

type OAuthDocument =
  | ReturnType<typeof protectedResourceMetadata>
  | ReturnType<typeof authorizationServerMetadata>
  | { readonly error: string; readonly error_description: string }
  | {
      readonly client_id: string
      readonly client_name: string
      readonly redirect_uris: ReadonlyArray<string>
      readonly grant_types: ReadonlyArray<string>
      readonly response_types: ReadonlyArray<string>
      readonly token_endpoint_auth_method: string
    }
  | { readonly access_token: string; readonly token_type: string; readonly expires_in: number }

const json = (status: number, body: OAuthDocument) =>
  HttpServerResponse.json(body, { status, headers: NO_STORE }).pipe(Effect.orDie)

const page = (status: number, html: string) =>
  HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: PAGE_HEADERS,
  })

const hostUrls = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const port = boundPort(request)

  if (port === undefined) return Option.none<OAuthUrls>()

  return Option.fromNullishOr(urlsFromHost(request.headers.host, port))
})

const missingHost = json(400, {
  error: "invalid_request",
  error_description: "The request host is missing.",
})

const queryOf = (url: URL): AuthorizationQuery => ({
  client_id: url.searchParams.get("client_id") ?? undefined,
  redirect_uri: url.searchParams.get("redirect_uri") ?? undefined,
  response_type: url.searchParams.get("response_type") ?? undefined,
  code_challenge: url.searchParams.get("code_challenge") ?? undefined,
  code_challenge_method: url.searchParams.get("code_challenge_method") ?? undefined,
  state: url.searchParams.get("state") ?? undefined,
  resource: url.searchParams.get("resource") ?? undefined,
})

const stringField = Schema.decodeUnknownOption(Schema.String)

const stringArray = Schema.decodeUnknownOption(Schema.Array(Schema.String))

const Decision = Schema.Struct({
  client_id: Schema.String,
  redirect_uri: Schema.String,
  code_challenge: Schema.String,
  code_challenge_method: Schema.String,
  response_type: Schema.String,
  state: Schema.String,
  resource: Schema.String,
  csrf: Schema.String,
  decision: Schema.Literals(["approve", "deny"]),
})

const readParam = (params: UrlParams.UrlParams, key: string) =>
  Option.getOrUndefined(UrlParams.getFirst(key)(params))

const shown = (error: OAuthPageError | OAuthRedirectError, issuer: string) =>
  Match.value(error).pipe(
    Match.tag("OAuthPageError", (pageError) => page(400, renderError(pageError.description))),
    Match.tag("OAuthRedirectError", (redirectError) =>
      HttpServerResponse.redirect(redirectForError(redirectError, issuer), {
        headers: REDIRECT_HEADERS,
      }),
    ),
    Match.exhaustive,
  )

const tokenFields = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest
  const contentType = request.headers["content-type"] ?? ""

  if (contentType.includes("application/json")) {
    const body = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject)

    return {
      grantType: Option.getOrUndefined(stringField(body.grant_type)),
      code: Option.getOrUndefined(stringField(body.code)),
      redirectUri: Option.getOrUndefined(stringField(body.redirect_uri)),
      clientId: Option.getOrUndefined(stringField(body.client_id)),
      verifier: Option.getOrUndefined(stringField(body.code_verifier)),
      resource: Option.getOrUndefined(stringField(body.resource)),
    }
  }

  const params = yield* request.urlParamsBody

  return {
    grantType: readParam(params, "grant_type"),
    code: readParam(params, "code"),
    redirectUri: readParam(params, "redirect_uri"),
    clientId: readParam(params, "client_id"),
    verifier: readParam(params, "code_verifier"),
    resource: readParam(params, "resource"),
  }
})

const metadata = (document: (urls: OAuthUrls) => OAuthDocument) =>
  Effect.gen(function* () {
    const found = yield* hostUrls

    if (Option.isNone(found)) return yield* missingHost

    return yield* json(200, document(found.value))
  })

const authorize = Effect.gen(function* () {
  const oauth = yield* McpOAuth
  const request = yield* HttpServerRequest.HttpServerRequest
  const found = yield* hostUrls

  if (Option.isNone(found)) return page(400, renderError("The request host is missing."))

  const validated = yield* oauth
    .validateAuthorization({
      urls: found.value,
      request: queryOf(new URL(request.url, found.value.issuer)),
    })
    .pipe(Effect.result)

  if (Result.isFailure(validated)) return shown(validated.failure, found.value.issuer)

  const authorization = validated.success

  return page(
    200,
    renderApproval(
      authorization,
      oauth.csrfFor({
        clientId: authorization.clientId,
        redirectUri: authorization.redirectUri,
        codeChallenge: authorization.codeChallenge,
        state: authorization.state,
        resource: authorization.resource,
      }),
    ),
  )
})

const decide = Effect.gen(function* () {
  const oauth = yield* McpOAuth
  const request = yield* HttpServerRequest.HttpServerRequest
  const found = yield* hostUrls

  if (Option.isNone(found)) return page(400, renderError("The request host is missing."))

  const origin = request.headers.origin

  // The Host check above already requires a loopback name on the bound port, so
  // this request reached the process Glass is listening on. Chrome sends the
  // literal origin "null" for this form because the page's referrer policy is
  // no-referrer. A page on another site still sends its own origin.
  if (origin !== undefined && origin !== "null" && origin !== found.value.issuer) {
    return page(400, renderError("This approval page is out of date. Start the sign-in again."))
  }

  const decoded = yield* HttpServerRequest.schemaBodyUrlParams(Decision).pipe(Effect.result)

  if (Result.isFailure(decoded)) {
    return page(400, renderError("This approval page is out of date. Start the sign-in again."))
  }

  const form = decoded.success

  if (
    !oauth.csrfMatches(
      {
        clientId: form.client_id,
        redirectUri: form.redirect_uri,
        codeChallenge: form.code_challenge,
        state: form.state,
        resource: form.resource,
      },
      form.csrf,
    )
  ) {
    return page(400, renderError("This approval page is out of date. Start the sign-in again."))
  }

  const validated = yield* oauth
    .validateAuthorization({
      urls: found.value,
      request: {
        client_id: form.client_id,
        redirect_uri: form.redirect_uri,
        response_type: form.response_type,
        code_challenge: form.code_challenge,
        code_challenge_method: form.code_challenge_method,
        state: form.state,
        resource: form.resource,
      },
    })
    .pipe(Effect.result)

  if (Result.isFailure(validated)) return shown(validated.failure, found.value.issuer)

  const target = yield* Match.value(form.decision).pipe(
    Match.when("deny", () => Effect.succeed(oauth.deny(validated.success))),
    Match.when("approve", () => oauth.approve(validated.success)),
    Match.exhaustive,
  )

  return HttpServerResponse.redirect(target, { headers: REDIRECT_HEADERS })
})

const register = Effect.gen(function* () {
  const oauth = yield* McpOAuth

  if (Option.isNone(yield* hostUrls)) return yield* missingHost

  const body = yield* HttpServerRequest.schemaBodyJson(Schema.JsonObject).pipe(Effect.result)

  if (Result.isFailure(body)) {
    return yield* json(400, {
      error: "invalid_client_metadata",
      error_description: "Expected a JSON registration object.",
    })
  }

  const redirectUris = stringArray(body.success.redirect_uris)

  if (Option.isNone(redirectUris)) {
    return yield* json(400, {
      error: "invalid_redirect_uri",
      error_description: "redirect_uris must be an array of strings.",
    })
  }

  const registered = yield* oauth
    .register({
      clientName: Option.getOrUndefined(stringField(body.success.client_name)),
      redirectUris: redirectUris.value,
    })
    .pipe(Effect.result)

  if (Result.isFailure(registered)) {
    return yield* json(400, {
      error: registered.failure.error,
      error_description: registered.failure.description,
    })
  }

  return yield* json(201, {
    client_id: registered.success.clientId,
    client_name: registered.success.name,
    redirect_uris: registered.success.redirectUris,
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  })
})

const token = Effect.gen(function* () {
  const oauth = yield* McpOAuth
  const outsideAgents = yield* OutsideAgents
  const found = yield* hostUrls

  if (Option.isNone(found)) return yield* missingHost

  const fields = yield* tokenFields.pipe(Effect.result)

  if (Result.isFailure(fields)) {
    return yield* json(400, {
      error: "invalid_request",
      error_description: "The token request could not be read.",
    })
  }

  const exchanged = yield* oauth
    .exchange({
      urls: found.value,
      grantType: fields.success.grantType,
      code: fields.success.code,
      redirectUri: fields.success.redirectUri,
      clientId: fields.success.clientId,
      verifier: fields.success.verifier,
      resource: fields.success.resource,
    })
    .pipe(Effect.result)

  if (Result.isFailure(exchanged)) {
    return yield* json(400, {
      error: exchanged.failure.error,
      error_description: exchanged.failure.description,
    })
  }

  const now = yield* DateTime.now

  const issued = yield* outsideAgents.issue({
    name: exchanged.success.name,
    ttl: OUTSIDE_AGENT_TTL,
  })

  return yield* json(200, {
    access_token: Redacted.value(issued.token),
    token_type: "Bearer",
    expires_in: Math.max(
      0,
      Math.floor((DateTime.toEpochMillis(issued.expiresAt) - DateTime.toEpochMillis(now)) / 1000),
    ),
  })
})

export const OAuthRoutes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/.well-known/oauth-protected-resource/mcp",
    metadata(protectedResourceMetadata),
  ),
  HttpRouter.add(
    "GET",
    "/.well-known/oauth-authorization-server",
    metadata(authorizationServerMetadata),
  ),
  HttpRouter.add("POST", "/oauth/mcp/register", register),
  HttpRouter.add("GET", "/oauth/mcp/authorize", authorize),
  HttpRouter.add("POST", "/oauth/mcp/decision", decide),
  HttpRouter.add("POST", "/oauth/mcp/token", token),
)

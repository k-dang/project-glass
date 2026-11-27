import { assert, describe, it } from "@effect/vitest"
import { GlobalChatCaller } from "./McpCredentials"
import { AskUserAnswered, AskUserResult, type InboxItems, OutsideText } from "@glass/contracts"
import { Effect, Fiber, Option, Predicate, Redacted, Schema, Stream } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { isolatedHome, startBackend } from "../../test/harness"
import { connectMcp, initialize, mcpPost, toolResult } from "../../test/mcpClient"

const outside = (items: InboxItems) =>
  items.filter((item) => Predicate.isTagged(item, "OutsideQuestion"))

const askResult = Schema.decodeUnknownSync(AskUserResult)

type Client = Effect.Success<ReturnType<typeof startBackend>>["client"]

const connectedThreads = (client: Client) =>
  client.WatchOutsideAgents().pipe(Stream.runHead, Effect.map(Option.getOrThrow))

const inboxNow = (client: Client) =>
  client.WatchInbox().pipe(Stream.runHead, Effect.map(Option.getOrThrow))

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  token_type: Schema.Literal("Bearer"),
  expires_in: Schema.Number,
})

const ErrorResponse = Schema.Struct({
  error: Schema.String,
  error_description: Schema.String,
})

const decodeToken = Schema.decodeUnknownSync(TokenResponse)

const decodeError = Schema.decodeUnknownSync(ErrorResponse)

const RegistrationResponse = Schema.Struct({ client_id: Schema.String })

const decodeRegistration = Schema.decodeUnknownSync(RegistrationResponse)

const decodeRegisteredJson = Schema.decodeUnknownSync(Schema.fromJsonString(RegistrationResponse))

const decodeCount = Schema.decodeUnknownSync(Schema.Struct({ n: Schema.Number }))

const ProtectedResource = Schema.Struct({
  resource: Schema.String,
  authorization_servers: Schema.Array(Schema.String),
  resource_name: Schema.String,
})

const decodeProtectedResource = Schema.decodeUnknownSync(ProtectedResource)

const AuthorizationServer = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  registration_endpoint: Schema.String,
  code_challenge_methods_supported: Schema.Array(Schema.String),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.String),
})

const decodeAuthorizationServer = Schema.decodeUnknownSync(AuthorizationServer)

const json = (response: Response) => response.json()

const verifierPair = () => {
  const verifier = randomBytes(32).toString("base64url")

  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  }
}

const start = Effect.gen(function* () {
  const home = yield* isolatedHome

  return { ...(yield* startBackend({}, home)), home }
})

const read = (response: Response) => Effect.promise(() => json(response))

const postJson = (
  url: string,
  body: { readonly client_name: string; readonly redirect_uris: ReadonlyArray<string> },
) =>
  Effect.promise(() =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    }),
  )

const fromAnotherSite = (dest: string) => ({
  "sec-fetch-site": "cross-site",
  "sec-fetch-dest": dest,
})

const signInRequests = (items: InboxItems) =>
  items.filter((item) => Predicate.isTagged(item, "OutsideAgentRequest"))

const authorizeUrl = (
  baseUrl: string,
  input: {
    readonly clientId: string
    readonly redirectUri: string
    readonly challenge: string
    readonly state: string
  },
) => {
  const authorize = new URL(`${baseUrl}/oauth/mcp/authorize`)

  authorize.searchParams.set("response_type", "code")
  authorize.searchParams.set("client_id", input.clientId)
  authorize.searchParams.set("redirect_uri", input.redirectUri)
  authorize.searchParams.set("code_challenge", input.challenge)
  authorize.searchParams.set("code_challenge_method", "S256")
  authorize.searchParams.set("state", input.state)

  return authorize
}

const register = (baseUrl: string, name: string, redirectUri: string) =>
  Effect.gen(function* () {
    const registered = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
      client_name: name,
      redirect_uris: [redirectUri],
    })

    assert.strictEqual(registered.status, 201)

    return decodeRegistration(yield* read(registered)).client_id
  })

const openAuthorize = (authorize: URL, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const page = yield* Effect.promise(() => fetch(authorize, { redirect: "manual", headers }))
    const html = yield* Effect.promise(() => page.text())
    const requestId = /request=([0-9a-f-]+)/.exec(html)?.[1]

    assert.strictEqual(page.status, 200)
    assert.ok(requestId !== undefined)

    return { html, requestId }
  })

const pollDecision = (baseUrl: string, requestId: string) =>
  Effect.promise(() =>
    fetch(`${baseUrl}/oauth/mcp/decision?request=${requestId}`, { redirect: "manual" }),
  )

const shownInInbox = (client: Client, requestId: string) =>
  client.WatchInbox().pipe(
    Stream.map((items) => signInRequests(items).find(({ id }) => id === requestId)),
    Stream.filter(Predicate.isNotUndefined),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )

const answerInGlass = (client: Client, requestId: string, decision: "approve" | "deny") =>
  Effect.gen(function* () {
    yield* shownInInbox(client, requestId)
    yield* client.AnswerOutsideAgentRequest({ id: requestId, decision })
  })

const approvedCode = (client: Client, baseUrl: string, authorize: URL) =>
  Effect.gen(function* () {
    const { requestId } = yield* openAuthorize(authorize)

    yield* answerInGlass(client, requestId, "approve")

    const decided = yield* pollDecision(baseUrl, requestId)
    const code = new URL(decided.headers.get("location") ?? "").searchParams.get("code")

    assert.strictEqual(decided.status, 302)
    assert.ok(code !== null)

    return code
  })

const exchange = (baseUrl: string, fields: Record<string, string>) =>
  Effect.promise(() =>
    fetch(`${baseUrl}/oauth/mcp/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({ grant_type: "authorization_code", ...fields }),
    }),
  )

const signIn = (baseUrl: string, client: Client, name: string) =>
  Effect.gen(function* () {
    const redirectUri = "http://127.0.0.1:9/callback"
    const { verifier, challenge } = verifierPair()
    const clientId = yield* register(baseUrl, name, redirectUri)

    const code = yield* approvedCode(
      client,
      baseUrl,
      authorizeUrl(baseUrl, { clientId, redirectUri, challenge, state: "sign-in" }),
    )

    const granted = yield* exchange(baseUrl, {
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: `${baseUrl}/mcp`,
    })

    const token = decodeToken(yield* read(granted))

    assert.strictEqual(granted.status, 200)

    return { token: Redacted.make(token.access_token), expiresIn: token.expires_in }
  })

describe("MCP OAuth", () => {
  it.live("serves protected-resource and authorization-server metadata", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* start
      const denied = yield* mcpPost(baseUrl, initialize)
      const metadata = denied.messages.length

      assert.strictEqual(denied.status, 401)
      assert.strictEqual(metadata, 0)

      const challenge = yield* Effect.promise(async () => {
        const response = await fetch(`${baseUrl}/mcp`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
          body: JSON.stringify(initialize),
        })

        return response.headers.get("www-authenticate") ?? ""
      })

      const resourceMetadata = challenge.match(/resource_metadata="([^"]+)"/)?.[1]

      assert.ok(resourceMetadata !== undefined)

      const protectedResource = yield* Effect.promise(() => fetch(resourceMetadata))

      const authorizationServer = yield* Effect.promise(() =>
        fetch(`${baseUrl}/.well-known/oauth-authorization-server`),
      )

      const resource = decodeProtectedResource(yield* read(protectedResource))
      const server = decodeAuthorizationServer(yield* read(authorizationServer))

      assert.strictEqual(protectedResource.status, 200)
      assert.strictEqual(resource.resource, `${baseUrl}/mcp`)
      assert.deepStrictEqual(resource.authorization_servers, [baseUrl])
      assert.strictEqual(resource.resource_name, "Glass")
      assert.strictEqual(authorizationServer.status, 200)
      assert.strictEqual(server.issuer, baseUrl)
      assert.strictEqual(server.authorization_endpoint, `${baseUrl}/oauth/mcp/authorize`)
      assert.strictEqual(server.token_endpoint, `${baseUrl}/oauth/mcp/token`)
      assert.strictEqual(server.registration_endpoint, `${baseUrl}/oauth/mcp/register`)
      assert.ok(server.code_challenge_methods_supported.includes("S256"))
      assert.deepStrictEqual(server.token_endpoint_auth_methods_supported, ["none"])
    }),
  )

  it.live("issues a token that can ask the user", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start

      const shownInSettings = yield* client.WatchOutsideAgents().pipe(
        Stream.filter((threads) => threads.length > 0),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.forkChild,
      )

      const { token, expiresIn } = yield* signIn(baseUrl, client, "Claude Code")
      const mcp = yield* connectMcp(baseUrl, token)

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: { question: "May I land the retry change?" },
      })

      const inFlight = yield* Effect.forkChild(call.response)

      const shown = yield* client.WatchInbox().pipe(
        Stream.filter((items) =>
          outside(items).some((item) => item.question === "May I land the retry change?"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const question = outside(shown).find(
        (item) => item.question === "May I land the retry change?",
      )

      const listed = yield* Fiber.join(shownInSettings)

      assert.ok(expiresIn > 29 * 24 * 60 * 60)
      assert.ok(expiresIn <= 30 * 24 * 60 * 60)
      assert.ok(question !== undefined)
      assert.strictEqual(question.askedBy, "Claude Code")
      assert.deepStrictEqual(
        listed.map((thread) => thread.name),
        ["Claude Code"],
      )

      yield* client.AnswerOutsideQuestion({
        id: question.id,
        answer: OutsideText.make({ text: "Yes" }),
      })

      assert.deepStrictEqual(
        askResult(toolResult(yield* Fiber.join(inFlight)).structuredContent),
        AskUserAnswered.make({ answer: "Yes", by: "text" }),
      )
    }),
  )

  it.live("gives a scripted sign-in no code until the user approves it in Glass", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"
      const { verifier, challenge } = verifierPair()
      const clientId = yield* register(baseUrl, "Claude Code", redirectUri)
      const authorize = authorizeUrl(baseUrl, { clientId, redirectUri, challenge, state: "forged" })
      const { html, requestId } = yield* openAuthorize(authorize)
      const reloaded = yield* openAuthorize(authorize)
      const waiting = yield* shownInInbox(client, requestId)
      const polled = yield* pollDecision(baseUrl, requestId)

      const traded = yield* exchange(baseUrl, {
        code: requestId,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      })

      assert.ok(html.includes("Approve Claude Code in Glass"))
      assert.strictEqual(reloaded.requestId, requestId)
      assert.deepStrictEqual(
        { name: waiting.name, redirectHost: waiting.redirectHost },
        { name: "Claude Code", redirectHost: "127.0.0.1:9" },
      )
      assert.strictEqual(polled.status, 200)
      assert.strictEqual(polled.headers.get("location"), null)
      assert.strictEqual(traded.status, 400)
      assert.strictEqual(decodeError(yield* read(traded)).error, "invalid_grant")
      assert.deepStrictEqual(yield* connectedThreads(client), [])
    }),
  )

  it.live("sends a sign-in the user denies in Glass back with access_denied", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"
      const { challenge } = verifierPair()
      const clientId = yield* register(baseUrl, "Claude Code", redirectUri)

      const { requestId } = yield* openAuthorize(
        authorizeUrl(baseUrl, { clientId, redirectUri, challenge, state: "denied" }),
      )

      yield* answerInGlass(client, requestId, "deny")

      const decided = yield* pollDecision(baseUrl, requestId)
      const location = new URL(decided.headers.get("location") ?? redirectUri)
      const again = yield* pollDecision(baseUrl, requestId)

      assert.strictEqual(decided.status, 302)
      assert.strictEqual(location.searchParams.get("error"), "access_denied")
      assert.strictEqual(location.searchParams.get("state"), "denied")
      assert.strictEqual(location.searchParams.get("code"), null)
      assert.strictEqual(again.status, 400)
      assert.deepStrictEqual(signInRequests(yield* inboxNow(client)), [])
    }),
  )

  it.live("rejects a bad or missing PKCE verifier", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"
      const clientId = yield* register(baseUrl, "Claude Code", redirectUri)
      const { verifier, challenge } = verifierPair()

      const code = yield* approvedCode(
        client,
        baseUrl,
        authorizeUrl(baseUrl, { clientId, redirectUri, challenge, state: "" }),
      )

      const wrong = yield* exchange(baseUrl, {
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: `${verifier}x`,
      })

      const spent = yield* exchange(baseUrl, {
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      })

      const missing = yield* exchange(baseUrl, {
        code: "missing-verifier-is-not-a-code",
        redirect_uri: redirectUri,
        client_id: clientId,
      })

      const withoutChallenge = new URL(`${baseUrl}/oauth/mcp/authorize`)

      withoutChallenge.searchParams.set("response_type", "code")
      withoutChallenge.searchParams.set("client_id", clientId)
      withoutChallenge.searchParams.set("redirect_uri", redirectUri)

      const rejected = yield* Effect.promise(() => fetch(withoutChallenge, { redirect: "manual" }))
      const rejectedLocation = new URL(rejected.headers.get("location") ?? redirectUri)

      assert.strictEqual(wrong.status, 400)
      assert.strictEqual(decodeError(yield* read(wrong)).error, "invalid_grant")
      assert.strictEqual(spent.status, 400)
      assert.strictEqual(decodeError(yield* read(spent)).error, "invalid_grant")
      assert.strictEqual(missing.status, 400)
      assert.strictEqual(decodeError(yield* read(missing)).error, "invalid_request")
      assert.strictEqual(rejected.status, 302)
      assert.strictEqual(rejectedLocation.searchParams.get("error"), "invalid_request")
      assert.strictEqual(rejectedLocation.searchParams.get("code"), null)
    }),
  )

  it.live("refuses a web page's background request but opens a sign-in its tab navigates to", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"
      const { challenge } = verifierPair()

      const clientId = yield* register(baseUrl, "Claude Code", redirectUri)

      const authorize = (state: string) =>
        authorizeUrl(baseUrl, { clientId, redirectUri, challenge, state })

      const statusOf = (state: string, dest: string) =>
        Effect.promise(() =>
          fetch(authorize(state), { redirect: "manual", headers: fromAnotherSite(dest) }),
        ).pipe(Effect.map(({ status }) => status))

      const fetched = yield* statusOf("fetched", "empty")
      const framed = yield* statusOf("framed", "iframe")

      const { requestId } = yield* openAuthorize(
        authorize("navigated"),
        fromAnotherSite("document"),
      )

      yield* shownInInbox(client, requestId)

      assert.deepStrictEqual({ fetched, framed }, { fetched: 403, framed: 403 })
      assert.deepStrictEqual(
        signInRequests(yield* inboxNow(client)).map(({ id }) => id),
        [requestId],
      )
    }),
  )

  it.live("rejects a redirect that is not loopback", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* start

      const http = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
        client_name: "Claude Code",
        redirect_uris: ["http://example.com/callback"],
      })

      const https = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
        client_name: "Claude Code",
        redirect_uris: ["https://example.com/callback"],
      })

      assert.strictEqual(http.status, 400)
      assert.strictEqual(decodeError(yield* read(http)).error, "invalid_redirect_uri")
      assert.strictEqual(https.status, 400)
      assert.strictEqual(decodeError(yield* read(https)).error, "invalid_redirect_uri")
    }),
  )

  it.live("rejects an MCP client token on a non-MCP route", () =>
    Effect.gen(function* () {
      const { baseUrl, client } = yield* start
      const { token } = yield* signIn(baseUrl, client, "Claude Code")

      const health = yield* Effect.promise(() =>
        fetch(`${baseUrl}/health`, {
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        }),
      )

      assert.strictEqual(health.status, 401)
    }),
  )

  it.live("rejects a revoked token and an expired token", () =>
    Effect.gen(function* () {
      const { baseUrl, client, home } = yield* start
      const { token } = yield* signIn(baseUrl, client, "Claude Code")
      const mcp = yield* connectMcp(baseUrl, token)
      const [thread] = yield* connectedThreads(client)

      assert.ok(thread !== undefined)
      assert.strictEqual((yield* mcp.request("tools/list", {}).response).status, 200)

      yield* client.RevokeOutsideAgent({ id: thread.id })

      assert.strictEqual((yield* mcp.request("tools/list", {}).response).status, 401)
      assert.deepStrictEqual(yield* connectedThreads(client), [])

      const again = yield* signIn(baseUrl, client, "Claude Code")

      yield* Effect.sync(() => {
        const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

        database.exec("UPDATE outside_agent SET expires_at = '2000-01-01T00:00:00.000Z'")
        database.close()
      })

      const expired = yield* mcpPost(baseUrl, initialize, { bearer: again.token })

      assert.strictEqual(expired.status, 401)
    }),
  )

  it.live("rejects a foreign Host before it can sign an outside agent in", () =>
    Effect.gen(function* () {
      const { baseUrl, home, mcpCredentials } = yield* start
      const target = new URL(baseUrl)
      const redirect = "http://127.0.0.1:9/callback"
      const verifier = "a".repeat(43)
      const challenge = createHash("sha256").update(verifier).digest("base64url")

      const send = (
        method: string,
        path: string,
        body: string,
        contentType: string,
        bearer?: string,
      ) =>
        Effect.promise(
          () =>
            new Promise<{ status: number; body: string; location: string | undefined }>(
              (resolve, reject) => {
                const headers = {
                  host: `rebind.example:${target.port}`,
                  origin: "null",
                  "content-type": contentType,
                  accept: "application/json, text/event-stream",
                }

                const signed =
                  bearer === undefined ? headers : { ...headers, authorization: `Bearer ${bearer}` }

                const sent = httpRequest(
                  {
                    hostname: target.hostname,
                    port: target.port,
                    path,
                    method,
                    headers: signed,
                  },
                  (response) => {
                    const chunks: Buffer[] = []

                    response.on("data", (chunk: Buffer) => chunks.push(chunk))
                    response.on("end", () =>
                      resolve({
                        status: response.statusCode ?? 0,
                        body: Buffer.concat(chunks).toString("utf8"),
                        location: response.headers.location,
                      }),
                    )
                  },
                )

                sent.on("error", reject)
                sent.end(body)
              },
            ),
        )

      const registered = yield* send(
        "POST",
        "/oauth/mcp/register",
        JSON.stringify({ client_name: "Rebinding", redirect_uris: [redirect] }),
        "application/json",
      )

      const clientId =
        registered.status === 201 ? decodeRegisteredJson(registered.body).client_id : "missing"

      const query = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        code_challenge: challenge,
        code_challenge_method: "S256",
        response_type: "code",
        state: "rebind",
        resource: `http://rebind.example:${target.port}/mcp`,
      })

      const authorized = yield* send(
        "GET",
        `/oauth/mcp/authorize?${query.toString()}`,
        "",
        "text/plain",
      )

      const requestId = /request=([0-9a-f-]+)/.exec(authorized.body)?.[1] ?? "missing"

      const decided = yield* send(
        "GET",
        `/oauth/mcp/decision?request=${requestId}`,
        "",
        "text/plain",
      )

      const code =
        decided.location === undefined
          ? "missing"
          : (new URL(decided.location, baseUrl).searchParams.get("code") ?? "missing")

      const traded = yield* send(
        "POST",
        "/oauth/mcp/token",
        new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirect,
          client_id: clientId,
          code_verifier: verifier,
          resource: `http://rebind.example:${target.port}/mcp`,
        }).toString(),
        "application/x-www-form-urlencoded",
      )

      const thread = yield* mcpCredentials.issue(
        GlobalChatCaller.make({ globalChatId: "rebind", sessionId: "rebind" }),
      )

      const mcp = yield* send(
        "POST",
        "/mcp",
        JSON.stringify(initialize),
        "application/json",
        Redacted.value(thread),
      )

      const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))
      const rows = decodeCount(database.prepare("SELECT COUNT(*) AS n FROM outside_agent").get())

      database.close()
      assert.deepStrictEqual(
        {
          registered: registered.status,
          authorized: authorized.status,
          decided: decided.status,
          traded: traded.status,
          mcp: mcp.status,
          rows: rows.n,
        },
        { registered: 400, authorized: 400, decided: 400, traded: 400, mcp: 401, rows: 0 },
      )
    }),
  )
})

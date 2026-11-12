import { assert, describe, it } from "@effect/vitest"
import { AskUserAnswered, AskUserResult, type NeedsYou, OutsideText } from "@glass/contracts"
import { Effect, Fiber, Option, Predicate, Redacted, Schema, Stream } from "effect"
import { createHash, randomBytes } from "node:crypto"
import { request as httpRequest } from "node:http"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"
import { isolatedHome, LAUNCH_TOKEN, startBackend } from "../../test/harness"
import { connectMcp, initialize, mcpPost, toolResult } from "../../test/mcpClient"

const outside = (items: NeedsYou) =>
  items.filter((item) => Predicate.isTagged(item, "OutsideQuestion"))

const askResult = Schema.decodeUnknownSync(AskUserResult)

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

const signIn = (baseUrl: string, name: string) =>
  Effect.gen(function* () {
    const redirectUri = "http://127.0.0.1:9/callback"
    const { verifier, challenge } = verifierPair()

    const registered = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
      client_name: name,
      redirect_uris: [redirectUri],
    })

    const registration = decodeRegistration(yield* read(registered))

    assert.strictEqual(registered.status, 201)

    const authorize = new URL(`${baseUrl}/oauth/mcp/authorize`)

    authorize.searchParams.set("response_type", "code")
    authorize.searchParams.set("client_id", registration.client_id)
    authorize.searchParams.set("redirect_uri", redirectUri)
    authorize.searchParams.set("code_challenge", challenge)
    authorize.searchParams.set("code_challenge_method", "S256")
    authorize.searchParams.set("state", "sign-in")

    const page = yield* Effect.promise(() => fetch(authorize))
    const html = yield* Effect.promise(() => page.text())
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]

    assert.strictEqual(page.status, 200)
    assert.ok(csrf !== undefined)
    assert.ok(html.includes(name))

    const decision = yield* Effect.promise(() =>
      fetch(`${baseUrl}/oauth/mcp/decision`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: registration.client_id,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          response_type: "code",
          state: "sign-in",
          resource: `${baseUrl}/mcp`,
          csrf,
          decision: "approve",
        }),
      }),
    )

    const location = decision.headers.get("location") ?? ""
    const code = new URL(location).searchParams.get("code")

    assert.strictEqual(decision.status, 302)
    assert.ok(code !== null)

    const granted = yield* Effect.promise(() =>
      fetch(`${baseUrl}/oauth/mcp/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: registration.client_id,
          code_verifier: verifier,
          resource: `${baseUrl}/mcp`,
        }),
      }),
    )

    const token = decodeToken(yield* read(granted))

    assert.strictEqual(granted.status, 200)

    return {
      token: Redacted.make(token.access_token),
      expiresIn: token.expires_in,
      clientId: registration.client_id,
      redirectUri,
      challenge,
    }
  })

describe("MCP OAuth", () => {
  it.live("serves protected-resource and authorization-server metadata", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* start
      const denied = yield* mcpPost(baseUrl, initialize)
      const metadata = denied.messages.length
      const header = denied.status === 401 ? "present" : "missing"

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

      assert.ok(header === "present")
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
      const { token, expiresIn } = yield* signIn(baseUrl, "Claude Code")
      const mcp = yield* connectMcp(baseUrl, token)

      const call = mcp.request("tools/call", {
        name: "ask_user",
        arguments: { question: "May I land the retry change?" },
      })

      const inFlight = yield* Effect.forkChild(call.response)

      const shown = yield* client.WatchNeedsYou().pipe(
        Stream.filter((items) =>
          outside(items).some((item) => item.question === "May I land the retry change?"),
        ),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      )

      const question = outside(shown).find(
        (item) => item.question === "May I land the retry change?",
      )

      const listed = yield* client.ListOutsideAgents()

      assert.ok(expiresIn > 29 * 24 * 60 * 60)
      assert.ok(expiresIn <= 30 * 24 * 60 * 60)
      assert.ok(question !== undefined)
      assert.strictEqual(question.label, "Claude Code")
      assert.ok(
        listed.some((agent) => agent.id === question.session && agent.name === "Claude Code"),
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

  it.live("rejects a bad or missing PKCE verifier", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"

      const registered = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
        client_name: "Claude Code",
        redirect_uris: [redirectUri],
      })

      const clientId = decodeRegistration(yield* read(registered)).client_id

      const approve = (challenge: string) =>
        Effect.gen(function* () {
          const authorize = new URL(`${baseUrl}/oauth/mcp/authorize`)

          authorize.searchParams.set("response_type", "code")
          authorize.searchParams.set("client_id", clientId)
          authorize.searchParams.set("redirect_uri", redirectUri)
          authorize.searchParams.set("code_challenge", challenge)
          authorize.searchParams.set("code_challenge_method", "S256")

          const page = yield* Effect.promise(() => fetch(authorize))
          const html = yield* Effect.promise(() => page.text())
          const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]

          assert.ok(csrf !== undefined)

          const decision = yield* Effect.promise(() =>
            fetch(`${baseUrl}/oauth/mcp/decision`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: clientId,
                redirect_uri: redirectUri,
                code_challenge: challenge,
                code_challenge_method: "S256",
                response_type: "code",
                state: "",
                resource: `${baseUrl}/mcp`,
                csrf,
                decision: "approve",
              }),
            }),
          )

          return new URL(decision.headers.get("location") ?? "").searchParams.get("code")
        })

      const { verifier, challenge } = verifierPair()
      const code = yield* approve(challenge)

      const wrong = yield* Effect.promise(() =>
        fetch(`${baseUrl}/oauth/mcp/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: `${verifier}x`,
          }),
        }),
      )

      const spent = yield* Effect.promise(() =>
        fetch(`${baseUrl}/oauth/mcp/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: code ?? "",
            redirect_uri: redirectUri,
            client_id: clientId,
            code_verifier: verifier,
          }),
        }),
      )

      const missing = yield* Effect.promise(() =>
        fetch(`${baseUrl}/oauth/mcp/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: "missing-verifier-is-not-a-code",
            redirect_uri: redirectUri,
            client_id: clientId,
          }),
        }),
      )

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
      const { baseUrl } = yield* start
      const { token } = yield* signIn(baseUrl, "Claude Code")

      const health = yield* Effect.promise(() =>
        fetch(`${baseUrl}/health?token=${LAUNCH_TOKEN}`, {
          headers: { authorization: `Bearer ${Redacted.value(token)}` },
        }),
      )

      const body = yield* Effect.promise(() => health.text())
      const open = yield* Effect.promise(() => fetch(`${baseUrl}/health?token=${LAUNCH_TOKEN}`))

      assert.strictEqual(health.status, 401)
      assert.strictEqual(body, "MCP client sessions are only accepted by the MCP endpoint.")
      assert.strictEqual(open.status, 204)
    }),
  )

  it.live("rejects a revoked token and an expired token", () =>
    Effect.gen(function* () {
      const { baseUrl, client, home } = yield* start
      const { token } = yield* signIn(baseUrl, "Claude Code")
      const mcp = yield* connectMcp(baseUrl, token)
      const [agent] = yield* client.ListOutsideAgents()

      assert.ok(agent !== undefined)
      assert.strictEqual((yield* mcp.request("tools/list", {}).response).status, 200)

      yield* client.RevokeOutsideAgent({ id: agent.id })

      assert.strictEqual((yield* mcp.request("tools/list", {}).response).status, 401)
      assert.deepStrictEqual(yield* client.ListOutsideAgents(), [])

      const again = yield* signIn(baseUrl, "Claude Code")

      yield* Effect.sync(() => {
        const database = new DatabaseSync(join(home, ".project-glass", "glass.db"))

        database.exec("UPDATE outside_agent SET expires_at = '2000-01-01T00:00:00.000Z'")
        database.close()
      })

      const expired = yield* mcpPost(baseUrl, initialize, { bearer: again.token })

      assert.strictEqual(expired.status, 401)
    }),
  )

  it.live("approves when the browser withholds its origin, and rejects a foreign one", () =>
    Effect.gen(function* () {
      const { baseUrl } = yield* start
      const redirectUri = "http://127.0.0.1:9/callback"
      const { challenge } = verifierPair()

      const registered = yield* postJson(`${baseUrl}/oauth/mcp/register`, {
        client_name: "Claude Code",
        redirect_uris: [redirectUri],
      })

      const clientId = decodeRegistration(yield* read(registered)).client_id
      const authorize = new URL(`${baseUrl}/oauth/mcp/authorize`)

      authorize.searchParams.set("response_type", "code")
      authorize.searchParams.set("client_id", clientId)
      authorize.searchParams.set("redirect_uri", redirectUri)
      authorize.searchParams.set("code_challenge", challenge)
      authorize.searchParams.set("code_challenge_method", "S256")
      authorize.searchParams.set("state", "chrome")

      const page = yield* Effect.promise(() => fetch(authorize))
      const html = yield* Effect.promise(() => page.text())
      const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1]

      assert.strictEqual(page.status, 200)
      assert.ok(csrf !== undefined)

      const policy = page.headers.get("content-security-policy") ?? ""

      assert.match(policy, /form-action[^;]*http:\/\/127\.0\.0\.1:\*/)
      assert.match(policy, /form-action[^;]*http:\/\/localhost:\*/)
      assert.notMatch(policy, /https:/)

      const form = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: "S256",
        response_type: "code",
        state: "chrome",
        resource: `${baseUrl}/mcp`,
        csrf,
        decision: "approve",
      })

      const post = (origin: string) =>
        Effect.promise(() =>
          fetch(`${baseUrl}/oauth/mcp/decision`, {
            method: "POST",
            redirect: "manual",
            headers: { "content-type": "application/x-www-form-urlencoded", origin },
            body: form,
          }),
        )

      const foreign = yield* post("https://evil.example")

      assert.strictEqual(foreign.status, 400)
      assert.strictEqual(foreign.headers.get("location"), null)

      const withheld = yield* post("null")
      const location = withheld.headers.get("location") ?? ""

      assert.strictEqual(withheld.status, 302)
      assert.ok(new URL(location).searchParams.get("code") !== null)
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

      const csrf = /name="csrf" value="([^"]+)"/.exec(authorized.body)?.[1] ?? "missing"

      const decided = yield* send(
        "POST",
        "/oauth/mcp/decision",
        new URLSearchParams({
          client_id: clientId,
          redirect_uri: redirect,
          code_challenge: challenge,
          code_challenge_method: "S256",
          response_type: "code",
          state: "rebind",
          resource: `http://rebind.example:${target.port}/mcp`,
          csrf,
          decision: "approve",
        }).toString(),
        "application/x-www-form-urlencoded",
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

      const conversation = yield* mcpCredentials.issue({ conversationId: "rebind" })

      const mcp = yield* send(
        "POST",
        "/mcp",
        JSON.stringify(initialize),
        "application/json",
        Redacted.value(conversation),
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

  it.live("keeps accepting a conversation bearer", () =>
    Effect.gen(function* () {
      const { baseUrl, client, mcpCredentials } = yield* start
      const bearer = yield* mcpCredentials.issue({ conversationId: "claude-code" })
      const mcp = yield* connectMcp(baseUrl, bearer)

      assert.strictEqual((yield* mcp.request("tools/list", {}).response).status, 200)
      assert.deepStrictEqual(yield* client.ListOutsideAgents(), [])
    }),
  )
})

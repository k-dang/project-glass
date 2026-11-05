import { Context, Deferred, Effect, Layer, Option, Redacted, type Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"

/** Who an MCP request comes from, resolved from its credential rather than tool arguments. */
export interface McpCallerIdentity {
  readonly conversationId: string
}

/** The authenticated caller of the MCP request being handled. */
export class McpCaller extends Context.Service<McpCaller, McpCallerIdentity>()(
  "@glass/server/McpCaller",
) {
  // Read from the fiber rather than required in the type: tool handlers are built once, while
  // their caller differs per request.
  static readonly current = Effect.serviceOption(McpCaller).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("MCP tool called outside an authenticated request"),
        onSome: Effect.succeed,
      }),
    ),
  )
}

// Credentials are kept by digest: a lookup compares no secret bytes, and memory holds no bearer.
const digest = (bearer: string) => createHash("sha256").update(bearer).digest("hex")

/** An unrevoked credential, as a request presenting it sees it. */
export interface McpCredential {
  readonly caller: McpCallerIdentity
  /** The MCP sessions this credential opened; no other credential may use them. */
  readonly sessions: Set<string>
  /** Completes when the credential is revoked. */
  readonly revoked: Effect.Effect<void>
}

/** Bearer credentials for conversation runtimes, issued per runtime and kept in memory only. */
export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /** Issues a credential for `caller`, revoked when the scope closes. */
    readonly issue: (
      caller: McpCallerIdentity,
    ) => Effect.Effect<Redacted.Redacted, never, Scope.Scope>
    /** Resolves a bearer to its credential while the credential is unrevoked. */
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<McpCredential>
  }
>()("@glass/server/McpCredentials") {
  static readonly layer = Layer.sync(McpCredentials, () => {
    const credentials = new Map<string, McpCredential>()

    return McpCredentials.of({
      issue: (caller) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const bearer = randomBytes(32).toString("base64url")
            const key = digest(bearer)
            const revoked = yield* Deferred.make<void>()

            credentials.set(key, { caller, sessions: new Set(), revoked: Deferred.await(revoked) })

            return { bearer: Redacted.make(bearer), key, revoked }
          }),
          ({ key, revoked }) =>
            Effect.sync(() => credentials.delete(key)).pipe(
              Effect.andThen(Deferred.succeed(revoked, undefined)),
            ),
        ).pipe(Effect.map(({ bearer }) => bearer)),
      authenticate: (bearer) =>
        Option.fromNullishOr(credentials.get(digest(Redacted.value(bearer)))),
    })
  })
}

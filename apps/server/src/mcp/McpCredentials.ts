import { Context, Deferred, Effect, Layer, Option, Redacted, type Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"

export interface McpCallerIdentity {
  readonly conversationId: string
}

export class McpCaller extends Context.Service<McpCaller, McpCallerIdentity>()(
  "@glass/server/McpCaller",
) {
  // `McpServer.toolkit` requires handler services when it is built, so a per-request caller can't
  // be a typed requirement.
  static readonly current = Effect.serviceOption(McpCaller).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("MCP tool called outside an authenticated request"),
        onSome: Effect.succeed,
      }),
    ),
  )
}

const digest = (bearer: string) => createHash("sha256").update(bearer).digest("hex")

export interface McpCredential {
  readonly caller: McpCallerIdentity
  readonly ownedSessions: Set<string>
  readonly revoked: Effect.Effect<void>
}

export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /** Issues a credential for `caller`, revoked when the scope closes. */
    readonly issue: (
      caller: McpCallerIdentity,
    ) => Effect.Effect<Redacted.Redacted, never, Scope.Scope>
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<McpCredential>
  }
>()("@glass/server/McpCredentials") {
  static readonly layer = Layer.sync(McpCredentials, () => {
    const credentialsByDigest = new Map<string, McpCredential>()

    return McpCredentials.of({
      issue: (caller) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const bearer = randomBytes(32).toString("base64url")
            const key = digest(bearer)
            const revoked = yield* Deferred.make<void>()

            credentialsByDigest.set(key, {
              caller,
              ownedSessions: new Set(),
              revoked: Deferred.await(revoked),
            })

            return { bearer: Redacted.make(bearer), key, revoked }
          }),
          ({ key, revoked }) =>
            Effect.sync(() => credentialsByDigest.delete(key)).pipe(
              Effect.andThen(Deferred.succeed(revoked, undefined)),
            ),
        ).pipe(Effect.map(({ bearer }) => bearer)),
      authenticate: (bearer) =>
        Option.fromNullishOr(credentialsByDigest.get(digest(Redacted.value(bearer)))),
    })
  })
}

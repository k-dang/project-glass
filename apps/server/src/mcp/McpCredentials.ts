import { Context, Effect, Layer, Option, Redacted, type Scope } from "effect"
import { createHash, randomBytes } from "node:crypto"

/**
 * Who an MCP request comes from. It is resolved from the request's credential, never from tool
 * arguments, so a tool's target cannot change who is asking.
 */
export interface McpCallerIdentity {
  readonly conversationId: string
}

/** The authenticated caller of the MCP request being handled. */
export class McpCaller extends Context.Service<McpCaller, McpCallerIdentity>()(
  "@glass/server/McpCaller",
) {
  /**
   * The current request's caller. Tool handlers run inside an authenticated request, so a missing
   * caller is a defect. Read from the fiber rather than required in the type, because tool
   * handlers are built once while their caller differs per request.
   */
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

/**
 * Bearer credentials for conversation runtimes calling the MCP endpoint. A credential is issued
 * when a runtime starts, is bound to that runtime's conversation, and is revoked when the runtime
 * ends; a restarted runtime gets a fresh one. Kept in memory only: they live no longer than the
 * backend that issued them.
 */
export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    /** Issues a credential for `caller`, revoked when the scope closes. */
    readonly issue: (
      caller: McpCallerIdentity,
    ) => Effect.Effect<Redacted.Redacted, never, Scope.Scope>
    /** Resolves a bearer credential to the caller it was issued to, while it is unrevoked. */
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<McpCallerIdentity>
  }
>()("@glass/server/McpCredentials") {
  static readonly layer = Layer.sync(McpCredentials, () => {
    const callers = new Map<string, McpCallerIdentity>()

    return McpCredentials.of({
      issue: (caller) =>
        Effect.suspend(() => {
          const bearer = randomBytes(32).toString("base64url")
          const key = digest(bearer)

          return Effect.acquireRelease(
            Effect.sync(() => callers.set(key, caller)),
            () => Effect.sync(() => callers.delete(key)),
          ).pipe(Effect.as(Redacted.make(bearer)))
        }),
      authenticate: (bearer) => Option.fromNullishOr(callers.get(digest(Redacted.value(bearer)))),
    })
  })
}

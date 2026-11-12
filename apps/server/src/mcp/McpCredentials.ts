import {
  Context,
  Deferred,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Schema,
  type Scope,
} from "effect"
import { createHash, randomBytes } from "node:crypto"

export class ConversationCaller extends Schema.TaggedClass<ConversationCaller>()("Conversation", {
  conversationId: Schema.String,
}) {}

export class OutsideAgentCaller extends Schema.TaggedClass<OutsideAgentCaller>()("OutsideAgent", {
  sessionId: Schema.String,
  name: Schema.String,
}) {}

export type McpCallerIdentity = ConversationCaller | OutsideAgentCaller

export const sessionOf = (caller: McpCallerIdentity) =>
  Match.value(caller).pipe(
    Match.tag("Conversation", ({ conversationId }) => conversationId),
    Match.tag("OutsideAgent", ({ sessionId }) => sessionId),
    Match.exhaustive,
  )

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
    readonly issue: (caller: {
      readonly conversationId: string
    }) => Effect.Effect<Redacted.Redacted, never, Scope.Scope>
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<McpCredential>
    /** The endpoint's URL, once the backend listens. */
    readonly endpoint: Effect.Effect<string>
    readonly listening: (url: string) => Effect.Effect<void>
  }
>()("@glass/server/McpCredentials") {
  static readonly layer = Layer.effect(
    McpCredentials,
    Effect.gen(function* () {
      const credentialsByDigest = new Map<string, McpCredential>()
      const endpoint = yield* Deferred.make<string>()

      return McpCredentials.of({
        issue: (caller) =>
          Effect.acquireRelease(
            Effect.gen(function* () {
              const bearer = randomBytes(32).toString("base64url")
              const key = digest(bearer)
              const revoked = yield* Deferred.make<void>()

              credentialsByDigest.set(key, {
                caller: new ConversationCaller({ conversationId: caller.conversationId }),
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
        endpoint: Deferred.await(endpoint),
        listening: (url) => Deferred.succeed(endpoint, url).pipe(Effect.asVoid),
      })
    }),
  )
}

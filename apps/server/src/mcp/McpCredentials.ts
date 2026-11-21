import { Context, Deferred, Effect, Exit, Layer, Option, Redacted, Schema, Scope } from "effect"
import { randomBytes, timingSafeEqual } from "node:crypto"
import type { GlassToolsAccess, StartOutcome } from "../agentHost/protocol"
import { digest } from "./mcpHttp"

export class GlobalChatCaller extends Schema.TaggedClass<GlobalChatCaller>()("GlobalChat", {
  globalChatId: Schema.String,
  sessionId: Schema.String,
}) {}

export class OutsideAgentCaller extends Schema.TaggedClass<OutsideAgentCaller>()("OutsideAgent", {
  agentId: Schema.String,
  name: Schema.String,
  session: Schema.String,
}) {}

export class ConversationCaller extends Schema.TaggedClass<ConversationCaller>()("Conversation", {
  conversationId: Schema.String,
}) {}

export type McpCallerIdentity = GlobalChatCaller | ConversationCaller | OutsideAgentCaller

export class McpCaller extends Context.Service<McpCaller, McpCallerIdentity>()(
  "@glass/server/McpCaller",
) {
  static readonly current = Effect.serviceOption(McpCaller).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.die("MCP tool called outside an authenticated request"),
        onSome: Effect.succeed,
      }),
    ),
  )
}

export const mintBearer = () => randomBytes(32).toString("base64url")

export const timingSafeSameSecret = (left: string, right: string) => {
  const a = Buffer.from(left)
  const b = Buffer.from(right)

  return a.length === b.length && timingSafeEqual(a, b)
}

export interface McpCredential {
  readonly caller: McpCallerIdentity
  readonly ownedSessions: Set<string>
  readonly revoked: Effect.Effect<void>
}

export class McpCredentials extends Context.Service<
  McpCredentials,
  {
    readonly issue: (
      caller: GlobalChatCaller,
    ) => Effect.Effect<Redacted.Redacted, never, Scope.Scope>
    readonly authenticate: (bearer: Redacted.Redacted) => Option.Option<McpCredential>
    readonly endpoint: Effect.Effect<string>
    readonly listening: (url: string) => Effect.Effect<void>
    readonly startWith: <E>(
      lifetime: Scope.Scope,
      caller: GlobalChatCaller,
      start: (access: GlassToolsAccess) => Effect.Effect<StartOutcome, E>,
    ) => Effect.Effect<StartOutcome, E>
    readonly revoke: (caller: GlobalChatCaller) => Effect.Effect<void>
  }
>()("@glass/server/McpCredentials") {
  static readonly layer = Layer.effect(
    McpCredentials,
    Effect.gen(function* () {
      const credentialsByDigest = new Map<string, McpCredential>()
      const endpoint = yield* Deferred.make<string>()
      const running = new Map<string, Scope.Closeable>()

      const replaceRunning = (key: string, next: Scope.Closeable | null) =>
        Effect.suspend(() => {
          const ending = running.get(key)

          if (next === null) running.delete(key)
          else running.set(key, next)

          return ending === undefined ? Effect.void : Scope.close(ending, Exit.void)
        })

      const issue = (caller: GlobalChatCaller) =>
        Effect.acquireRelease(
          Effect.gen(function* () {
            const bearer = mintBearer()
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
        ).pipe(Effect.map(({ bearer }) => bearer))

      return McpCredentials.of({
        issue,
        authenticate: (bearer) =>
          Option.fromNullishOr(credentialsByDigest.get(digest(Redacted.value(bearer)))),
        endpoint: Deferred.await(endpoint),
        listening: (url) => Deferred.succeed(endpoint, url).pipe(Effect.asVoid),
        startWith: (lifetime, caller, start) =>
          Effect.gen(function* () {
            const credential = yield* Scope.fork(lifetime)
            const revoke = Scope.close(credential, Exit.void)

            const access = {
              url: yield* Deferred.await(endpoint),
              bearer: yield* issue(caller).pipe(Scope.provide(credential)),
            }

            const started = yield* start(access).pipe(Effect.onError(() => revoke))

            yield* started === "started" ? replaceRunning(caller.globalChatId, credential) : revoke

            return started
          }),
        revoke: (caller) => replaceRunning(caller.globalChatId, null),
      })
    }),
  )
}

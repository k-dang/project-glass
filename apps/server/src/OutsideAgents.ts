import { OutsideAgent, OutsideAgentNotFound } from "@glass/contracts"
import {
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Layer,
  Option,
  Redacted,
  Schema,
} from "effect"
import { SqlClient } from "effect/sql"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { OutsideAgentCaller, type McpCredential } from "./mcp/McpCredentials"

/** A connected outside agent stays signed in for about as long as t3code's MCP sessions. */
export const OUTSIDE_AGENT_TTL = Duration.days(30)

const digest = (bearer: string) => createHash("sha256").update(bearer).digest("hex")

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      issued_at: Schema.String,
      expires_at: Schema.String,
      revoked_at: Schema.NullOr(Schema.String),
    }),
  ),
)

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

const instant = Schema.decodeUnknownOption(Schema.DateTimeUtcFromString)

interface LiveSession {
  readonly ownedSessions: Set<string>
  readonly revoked: Deferred.Deferred<void>
}

const agent = (row: {
  readonly id: string
  readonly name: string
  readonly issued_at: string
  readonly expires_at: string
}) => {
  const issuedAt = instant(row.issued_at)
  const expiresAt = instant(row.expires_at)

  if (Option.isNone(issuedAt) || Option.isNone(expiresAt)) return undefined

  return new OutsideAgent({
    id: row.id,
    name: row.name,
    issuedAt: issuedAt.value,
    expiresAt: expiresAt.value,
  })
}

export class OutsideAgents extends Context.Service<
  OutsideAgents,
  {
    readonly issue: (input: {
      readonly name: string
      readonly ttl: Duration.Duration
    }) => Effect.Effect<{
      readonly id: string
      readonly token: Redacted.Redacted
      readonly expiresAt: DateTime.DateTime
    }>
    readonly authenticate: (
      bearer: Redacted.Redacted,
    ) => Effect.Effect<Option.Option<McpCredential>>
    readonly list: () => Effect.Effect<ReadonlyArray<OutsideAgent>>
    readonly revoke: (id: string) => Effect.Effect<void, OutsideAgentNotFound>
  }
>()("@glass/server/OutsideAgents") {
  static readonly layer = Layer.effect(
    OutsideAgents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const revokedIds = new Set<string>()
      const live = new Map<string, LiveSession>()

      const credential = (id: string, name: string, session: LiveSession): McpCredential => ({
        caller: new OutsideAgentCaller({ sessionId: id, name }),
        ownedSessions: session.ownedSessions,
        revoked: Deferred.await(session.revoked),
      })

      const open = (id: string, name: string) =>
        Effect.gen(function* () {
          if (revokedIds.has(id)) return Option.none<McpCredential>()

          const existing = live.get(id)

          if (existing !== undefined) return Option.some(credential(id, name, existing))

          const revoked = yield* Deferred.make<void>()
          const created: LiveSession = { ownedSessions: new Set(), revoked }

          live.set(id, created)

          if (revokedIds.has(id)) {
            yield* Deferred.succeed(revoked, undefined)

            return Option.none<McpCredential>()
          }

          return Option.some(credential(id, name, created))
        })

      const list = Effect.gen(function* () {
        const now = DateTime.formatIso(yield* DateTime.now)

        const rows = yield* sql`
          SELECT id, name, issued_at, expires_at, revoked_at
          FROM outside_agent
          WHERE revoked_at IS NULL AND expires_at > ${now}
          ORDER BY issued_at
        `.pipe(Effect.orDie)

        const decoded = yield* decodeRows(rows).pipe(Effect.orDie)

        return decoded.flatMap((row) => {
          const listed = agent(row)

          return listed === undefined ? [] : [listed]
        })
      })

      return OutsideAgents.of({
        issue: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now
            const expiresAt = DateTime.addDuration(now, input.ttl)
            const id = randomUUID()
            const token = randomBytes(32).toString("base64url")

            yield* sql`
              INSERT INTO outside_agent (id, name, token_digest, issued_at, expires_at)
              VALUES (
                ${id},
                ${input.name},
                ${digest(token)},
                ${DateTime.formatIso(now)},
                ${DateTime.formatIso(expiresAt)}
              )
            `.pipe(Effect.orDie)

            return { id, token: Redacted.make(token), expiresAt }
          }),
        authenticate: (bearer) =>
          Effect.gen(function* () {
            const rows = yield* sql`
              SELECT id, name, issued_at, expires_at, revoked_at
              FROM outside_agent
              WHERE token_digest = ${digest(Redacted.value(bearer))}
            `.pipe(Effect.orDie)

            const decoded = yield* decodeRows(rows).pipe(Effect.orDie)
            const row = decoded[0]

            if (row === undefined || row.revoked_at !== null || revokedIds.has(row.id)) {
              return Option.none<McpCredential>()
            }

            const listed = agent(row)
            const now = DateTime.toEpochMillis(yield* DateTime.now)

            if (listed === undefined || DateTime.toEpochMillis(listed.expiresAt) <= now) {
              return Option.none<McpCredential>()
            }

            return yield* open(listed.id, listed.name)
          }),
        list: () => list,
        revoke: (id) =>
          Effect.gen(function* () {
            const now = DateTime.formatIso(yield* DateTime.now)

            const rows = yield* sql`
              UPDATE outside_agent
              SET revoked_at = ${now}
              WHERE id = ${id} AND revoked_at IS NULL
              RETURNING id
            `.pipe(Effect.orDie)

            const updated = yield* decodeIds(rows).pipe(Effect.orDie)

            if (updated.length === 0) return yield* new OutsideAgentNotFound()

            revokedIds.add(id)
            const session = live.get(id)

            if (session !== undefined) yield* Deferred.succeed(session.revoked, undefined)

            return yield* Effect.void
          }),
      })
    }),
  )
}

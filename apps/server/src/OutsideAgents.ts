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
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { digest, mintBearer, OutsideAgentCaller, type McpCredential } from "./mcp/McpCredentials"

export const OUTSIDE_AGENT_TTL = Duration.days(30)

const AgentRow = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  issued_at: Schema.DateTimeUtcFromString,
  expires_at: Schema.DateTimeUtcFromString,
})

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(AgentRow))

const agentOf = (row: typeof AgentRow.Type) =>
  new OutsideAgent({
    id: row.id,
    name: row.name,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
  })

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

interface LiveAgent {
  readonly ownedSessions: Set<string>
  readonly revoked: Deferred.Deferred<void>
}

export class OutsideAgents extends Context.Service<
  OutsideAgents,
  {
    /** Approves an app under `name` for `OUTSIDE_AGENT_TTL` and returns its bearer. */
    readonly issue: (name: string) => Effect.Effect<Redacted.Redacted>
    readonly authenticate: (
      bearer: Redacted.Redacted,
    ) => Effect.Effect<Option.Option<McpCredential>>
    /** The connected outside agents, again whenever one connects or is disconnected. */
    readonly watch: () => Stream.Stream<ReadonlyArray<OutsideAgent>>
    readonly revoke: (id: string) => Effect.Effect<void, OutsideAgentNotFound>
  }
>()("@glass/server/OutsideAgents") {
  static readonly layer = Layer.effect(
    OutsideAgents,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const live = new Map<string, LiveAgent>()
      const changed = yield* SubscriptionRef.make(0)
      const bump = SubscriptionRef.update(changed, (count) => count + 1)

      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

      const liveAgent = Effect.fnUntraced(function* (id: string) {
        const existing = live.get(id)

        if (existing !== undefined) return existing

        const created: LiveAgent = {
          ownedSessions: new Set(),
          revoked: yield* Deferred.make<void>(),
        }

        live.set(id, created)

        return created
      })

      const connected = Effect.gen(function* () {
        const rows = yield* sql`
          SELECT id, name, issued_at, expires_at
          FROM outside_agent
          WHERE revoked_at IS NULL AND expires_at > ${yield* now}
          ORDER BY issued_at
        `.pipe(Effect.orDie)

        return yield* decodeRows(rows).pipe(
          Effect.map((decoded) => decoded.map(agentOf)),
          Effect.orDie,
        )
      })

      return OutsideAgents.of({
        issue: (name) =>
          Effect.gen(function* () {
            const issuedAt = yield* DateTime.now
            const expiresAt = DateTime.addDuration(issuedAt, OUTSIDE_AGENT_TTL)
            const token = mintBearer()

            const spent = yield* sql`
              DELETE FROM outside_agent
              WHERE revoked_at IS NOT NULL OR expires_at <= ${DateTime.formatIso(issuedAt)}
              RETURNING id
            `.pipe(Effect.orDie)

            for (const { id } of yield* decodeIds(spent).pipe(Effect.orDie)) live.delete(id)

            yield* sql`
              INSERT INTO outside_agent (id, name, token_digest, issued_at, expires_at)
              VALUES (
                ${randomUUID()},
                ${name},
                ${digest(token)},
                ${DateTime.formatIso(issuedAt)},
                ${DateTime.formatIso(expiresAt)}
              )
            `.pipe(Effect.orDie)

            yield* bump

            return Redacted.make(token)
          }),
        authenticate: (bearer) =>
          Effect.gen(function* () {
            const rows = yield* sql`
              SELECT id, name, issued_at, expires_at
              FROM outside_agent
              WHERE token_digest = ${digest(Redacted.value(bearer))}
                AND revoked_at IS NULL
                AND expires_at > ${yield* now}
            `.pipe(Effect.orDie)

            const [agent] = yield* decodeRows(rows).pipe(
              Effect.map((decoded) => decoded.map(agentOf)),
              Effect.orDie,
            )

            if (agent === undefined) return Option.none<McpCredential>()

            const { ownedSessions, revoked } = yield* liveAgent(agent.id)

            return Option.some<McpCredential>({
              caller: new OutsideAgentCaller({
                agentId: agent.id,
                name: agent.name,
                session: agent.id,
              }),
              ownedSessions,
              revoked: Deferred.await(revoked),
            })
          }),
        watch: () => SubscriptionRef.changes(changed).pipe(Stream.mapEffect(() => connected)),
        revoke: (id) =>
          Effect.gen(function* () {
            const rows = yield* sql`
              UPDATE outside_agent
              SET revoked_at = ${yield* now}
              WHERE id = ${id} AND revoked_at IS NULL
              RETURNING id
            `.pipe(Effect.orDie)

            if ((yield* decodeIds(rows).pipe(Effect.orDie)).length === 0) {
              return yield* new OutsideAgentNotFound()
            }

            const session = live.get(id)

            live.delete(id)

            if (session !== undefined) yield* Deferred.succeed(session.revoked, undefined)

            return yield* bump
          }),
      })
    }),
  )
}

import {
  type AgentBusy,
  type QueuedMessageStarted,
  AgentError,
  type MessageInputWithContext,
  ModelChoice,
  PastConversation,
  PastConversationNotFound,
  type RequestAnswer,
  type RequestNotWaiting,
  type RequestWaiting,
  type SentMessage,
  StartFreshRefused,
  type Transcript,
  type TranscriptUpdate,
  TurnEnd,
  type WorkReport,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { GlobalRole } from "./agentHost/protocol"
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import { LocalAgentHost } from "./LocalAgentHost"
import { McpCredentials } from "./mcp/McpCredentials"
import type { HostClient } from "./Placement"
import { ServerConfig } from "./ServerConfig"
import { Transcripts, type WaitingRequest } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const StoredConversation = Schema.Struct({
  id: Schema.String,
  sessionId: Schema.String,
  ...ModelChoice.fields,
})

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredConversation))

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

const decodePast = Schema.decodeUnknownEffect(Schema.Array(PastConversation))

const hostGone = new AgentError({ message: "Glass lost the process that runs Agents. Try again." })

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save the Global conversation. Try again." })

const stored = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning(`Couldn't ${what}`, cause)),
    Effect.mapError(storageFailure),
  )

export class GlobalConversation extends Context.Service<
  GlobalConversation,
  {
    readonly model: Effect.Effect<ModelChoice>
    readonly changeModel: (choice: ModelChoice) => Effect.Effect<void, AgentError>
    readonly transcript: Stream.Stream<TranscriptUpdate, AgentError>
    readonly send: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly steer: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly cancelQueued: (
      queuedId: string,
    ) => Effect.Effect<void, QueuedMessageStarted | AgentError>
    readonly sendQueued: (queuedId: string) => Effect.Effect<void, AgentBusy | AgentError>
    readonly stop: Effect.Effect<void, AgentError>
    readonly answer: (
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | AgentError>
    readonly unsent: Effect.Effect<SentMessage, AgentError>
    readonly saveUnsent: (unsent: SentMessage) => Effect.Effect<void, AgentError>
    readonly id: string
    readonly startFresh: Effect.Effect<void, StartFreshRefused | AgentError>
    readonly past: Effect.Effect<ReadonlyArray<PastConversation>, AgentError>
    readonly readPast: (
      sessionId: string,
    ) => Effect.Effect<Transcript, PastConversationNotFound | AgentError>
    readonly waiting: Stream.Stream<ReadonlyArray<WaitingRequest>>
    readonly unseen: Stream.Stream<TurnEnd | null>
    readonly markSeen: (endedAt: DateTime.Utc) => Effect.Effect<void, AgentError>
    readonly whenIdle: <E>(
      effect: (
        report: (
          report: WorkReport,
          record: (turnId: string) => Effect.Effect<void, AgentError>,
        ) => Effect.Effect<void, AgentError>,
      ) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | AgentError>
  }
>()("@glass/server/GlobalConversation") {
  static readonly layer = Layer.effect(
    GlobalConversation,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const transcripts = yield* Transcripts
      const turns = yield* ConversationTurns
      const host = yield* LocalAgentHost
      const credentials = yield* McpCredentials
      const folder = join(config.dataDirectory, "global-conversation")

      const [saved] = yield* sql`
        SELECT id, session_id AS sessionId, model, effort FROM global_conversation LIMIT 1
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const id = saved?.id ?? randomUUID()
      const firstSession = saved?.sessionId ?? randomUUID()

      if (saved === undefined)
        yield* sql`INSERT INTO global_conversation ${sql.insert({
          id,
          session_id: firstSession,
          session_started_at: DateTime.formatIso(yield* DateTime.now),
          model: null,
          effort: null,
        })}`.pipe(Effect.orDie)

      const session = yield* SubscriptionRef.make(firstSession)

      const sessionLock = yield* Semaphore.make(1)

      const model = yield* SubscriptionRef.make<ModelChoice>({
        model: saved?.model ?? null,
        effort: saved?.effort ?? null,
      })

      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.orDie)

      // Each start of pi gets a fresh credential, revoked when it is replaced, when Start fresh
      // stops pi, and with the host's lifetime when the host stops.
      const starting = yield* Semaphore.make(1)
      let runningCredential: Scope.Closeable | null = null

      const replaceRunning = (next: Scope.Closeable | null) =>
        Effect.suspend(() => {
          const ending = runningCredential
          runningCredential = next

          return ending === null ? Effect.void : Scope.close(ending, Exit.void)
        })

      const start = (sessionId: string) => (client: HostClient) =>
        starting.withPermits(1)(
          Effect.gen(function* () {
            const lifetime = yield* host.lifetimeOf(client).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.mapError(() => hostGone),
            )

            const credential = yield* Scope.fork(lifetime)
            const revoke = Scope.close(credential, Exit.void)

            const role = GlobalRole.make({
              tools: {
                url: yield* credentials.endpoint,
                bearer: yield* credentials
                  .issue({ conversationId: id, sessionId })
                  .pipe(Scope.provide(credential)),
              },
            })

            const started = yield* client
              .StartAgent({ agentId: sessionId, engine: "pi", folder, role, skills: [] })
              .pipe(Effect.onError(() => revoke))

            yield* started ? replaceRunning(credential) : revoke
          }),
        )

      const stopProgram = (sessionId: string) =>
        starting.withPermits(1)(
          Effect.gen(function* () {
            const running = yield* host.running

            if (Option.isSome(running))
              yield* running.value
                .StopAgent({ agentId: sessionId })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("Couldn't stop pi for the ended Global conversation", cause),
                  ),
                )

            yield* replaceRunning(null)
          }),
        )

      const conversationOf = (sessionId: string) =>
        SubscriptionRef.get(model).pipe(
          Effect.map((choice): Conversation => ({
            id: sessionId,
            start: start(sessionId),
            settings: { ...choice, permissionMode: null },
            host: host.client,
            runningHost: host.running,
          })),
        )

      const currentSession = SubscriptionRef.get(session)

      const conversation = currentSession.pipe(Effect.flatMap(conversationOf))

      const currentSessions = currentSession.pipe(Effect.map((sessionId) => [sessionId]))

      const inSession = <A, E>(effect: (sessionId: string) => Effect.Effect<A, E>) =>
        sessionLock.withPermits(1)(currentSession.pipe(Effect.flatMap(effect)))

      const inConversation = <A, E>(effect: (current: Conversation) => Effect.Effect<A, E>) =>
        inSession((sessionId) => conversationOf(sessionId).pipe(Effect.flatMap(effect)))

      const followSession = <A, E>(stream: (sessionId: string) => Stream.Stream<A, E>) =>
        SubscriptionRef.changes(session).pipe(Stream.switchMap(stream))

      yield* turns.serve({
        claim: (conversationId) =>
          conversation.pipe(
            Effect.map((current) =>
              current.id === conversationId ? Option.some(current) : Option.none(),
            ),
          ),
        lost: (yield* host.subscribeStopped).pipe(Stream.mapEffect(() => currentSessions)),
        interrupted: currentSessions,
      })

      const changeModel = Effect.fn("GlobalConversation.changeModel")(function* (
        choice: ModelChoice,
      ) {
        yield* stored(
          "save the Global conversation's model",
          sql`
            UPDATE global_conversation
            SET model = ${choice.model}, effort = ${choice.effort}
            WHERE id = ${id}
          `,
        )
        yield* SubscriptionRef.set(model, choice)
      })

      const refusal = (sessionId: string) =>
        Effect.gen(function* () {
          if (yield* transcripts.isWaiting(sessionId)) return "waiting" as const

          if ((yield* transcripts.runningTurn(sessionId)) !== null) return "running" as const

          if (!(yield* transcripts.idle(sessionId))) return "queued" as const

          return null
        })

      const startFresh = inSession((ending) =>
        Effect.gen(function* () {
          const reason = yield* refusal(ending)

          if (reason !== null) yield* new StartFreshRefused({ reason })

          const next = randomUUID()
          const at = DateTime.formatIso(yield* DateTime.now)

          yield* stopProgram(ending)
          yield* stored(
            "start the Global conversation fresh",
            sql.withTransaction(
              Effect.all(
                [
                  sql`
                    INSERT INTO past_global_conversation (id, started_at, ended_at)
                    SELECT session_id, session_started_at, ${at} FROM global_conversation
                  `,
                  sql`
                    UPDATE global_conversation
                    SET session_id = ${next}, session_started_at = ${at}, turn_seen_at = NULL
                  `,
                ],
                { discard: true },
              ),
            ),
          )
          yield* SubscriptionRef.set(session, next)
          yield* annotateUnit({ agent_id: next })
        }),
      ).pipe(Effect.withSpan("GlobalConversation.startFresh"))

      const past = stored(
        "read past Global conversations",
        sql`
          SELECT id, started_at AS startedAt, ended_at AS endedAt
          FROM past_global_conversation ORDER BY started_at DESC
        `.pipe(Effect.flatMap(decodePast)),
      )

      const readPast = Effect.fn("GlobalConversation.readPast")(function* (sessionId: string) {
        const [ended] = yield* stored(
          "read a past Global conversation",
          sql`
            SELECT id FROM past_global_conversation WHERE id = ${sessionId}
          `.pipe(Effect.flatMap(decodeIds)),
        )

        if (ended === undefined) return yield* new PastConversationNotFound({ id: sessionId })

        return yield* transcripts.read(sessionId)
      })

      return GlobalConversation.of({
        model: SubscriptionRef.get(model),
        changeModel,
        transcript: followSession(transcripts.watch),
        send: (input) => inSession((sessionId) => turns.send(sessionId, input)).pipe(Effect.asVoid),
        steer: (input) => inConversation((current) => turns.steer(current, input)),
        cancelQueued: (queuedId) =>
          inSession((sessionId) => transcripts.cancelQueued(sessionId, queuedId)),
        sendQueued: (queuedId) => inSession((sessionId) => turns.sendQueued(sessionId, queuedId)),
        stop: inConversation(turns.stop),
        answer: (requestId, answer) =>
          inConversation((current) => turns.answer(current, requestId, answer)),
        unsent: turns.unsent(id),
        saveUnsent: (unsent) => turns.saveUnsent(id, unsent),
        id,
        startFresh,
        past,
        readPast,
        waiting: followSession((sessionId) =>
          transcripts.waiting.pipe(Stream.map((waiting) => waiting.get(sessionId) ?? [])),
        ),
        unseen: followSession((sessionId) =>
          transcripts.unseen.pipe(Stream.map((unseen) => unseen.get(sessionId) ?? null)),
        ).pipe(Stream.changesWith(Schema.toEquivalence(Schema.NullOr(TurnEnd)))),
        markSeen: (endedAt) => inSession((sessionId) => transcripts.markSeen(sessionId, endedAt)),
        whenIdle: (effect) => inSession((sessionId) => turns.whenIdle(sessionId, effect)),
      })
    }),
  )
}

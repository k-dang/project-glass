import {
  type ThreadBusy,
  type QueuedMessageStarted,
  ThreadError,
  type MessageInputWithContext,
  EndedGlobalChatSession,
  GlobalChatSessionNotFound,
  ModelChoice,
  type RequestAnswer,
  type RequestNotWaiting,
  type RequestWaiting,
  type SentMessage,
  StartFreshRefused,
  type TranscriptUpdate,
  TurnEnd,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { GlobalRole } from "./agentHost/protocol"
import { LocalAgentHost } from "./LocalAgentHost"
import { GlobalChatCaller, McpCredentials } from "./mcp/McpCredentials"
import { type ClaimedThread, type ThreadHost, ThreadTurns, type StartIdle } from "./ThreadTurns"
import { boundHostCall } from "./hostControl"
import { ServerConfig } from "./ServerConfig"
import { Transcripts, type WaitingRequest } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const StoredGlobalChat = Schema.Struct({
  id: Schema.String,
  ...ModelChoice.fields,
})

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredGlobalChat))

const decodeIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

const decodeEnded = Schema.decodeUnknownEffect(Schema.Array(EndedGlobalChatSession))

const hostGone = new ThreadError({
  message: "Glass lost the process that runs Threads. Try again.",
})

const storageFailure = () =>
  new ThreadError({ message: "Couldn't read or save the Global chat. Try again." })

const stored = <A, E, R>(what: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning(`Couldn't ${what}`, cause)),
    Effect.mapError(storageFailure),
  )

export class GlobalChat extends Context.Service<
  GlobalChat,
  {
    readonly model: Effect.Effect<ModelChoice>
    readonly changeModel: (choice: ModelChoice) => Effect.Effect<void, ThreadError>
    readonly transcript: Stream.Stream<TranscriptUpdate, ThreadError>
    readonly send: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | ThreadError>
    readonly steer: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | ThreadError>
    readonly cancelQueued: (
      queuedId: string,
    ) => Effect.Effect<void, QueuedMessageStarted | ThreadError>
    readonly sendQueued: (queuedId: string) => Effect.Effect<void, ThreadBusy | ThreadError>
    readonly stop: Effect.Effect<void, ThreadError>
    readonly answer: (
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | ThreadError>
    readonly unsent: Effect.Effect<SentMessage, ThreadError>
    readonly saveUnsent: (unsent: SentMessage) => Effect.Effect<void, ThreadError>
    readonly id: string
    readonly startFresh: Effect.Effect<void, StartFreshRefused | ThreadError>
    readonly endedSessions: Effect.Effect<ReadonlyArray<EndedGlobalChatSession>, ThreadError>
    readonly loadEarlier: (before: string) => Effect.Effect<void, ThreadError>
    readonly watchSession: (
      sessionId: string,
    ) => Stream.Stream<TranscriptUpdate, GlobalChatSessionNotFound | ThreadError>
    readonly loadEarlierInSession: (
      sessionId: string,
      before: string,
    ) => Effect.Effect<void, GlobalChatSessionNotFound | ThreadError>
    readonly waiting: Stream.Stream<ReadonlyArray<WaitingRequest>>
    readonly unseen: Stream.Stream<TurnEnd | null>
    readonly markSeen: (endedAt: DateTime.Utc) => Effect.Effect<void, ThreadError>
    readonly whenIdle: <E>(
      effect: (start: StartIdle, sessionId: string) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | ThreadError>
  }
>()("@glass/server/GlobalChat") {
  static readonly layer = Layer.effect(
    GlobalChat,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      const transcripts = yield* Transcripts
      const turns = yield* ThreadTurns
      const host = yield* LocalAgentHost
      const credentials = yield* McpCredentials
      // WARNING: pi keys its session files by working directory; renaming this folder loses the live session.
      const folder = join(config.dataDirectory, "global-conversation")

      const [saved] = yield* sql`
        SELECT id, model, effort FROM global_chat LIMIT 1
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const id = saved?.id ?? randomUUID()

      if (saved === undefined)
        yield* sql`INSERT INTO global_chat ${sql.insert({ id, model: null, effort: null })}`.pipe(
          Effect.orDie,
        )

      const [currentRow] = yield* sql`
        SELECT id FROM global_chat_session WHERE ended_at IS NULL
      `.pipe(Effect.flatMap(decodeIds), Effect.orDie)

      const firstSession = currentRow?.id ?? randomUUID()

      if (currentRow === undefined)
        yield* sql`INSERT INTO global_chat_session ${sql.insert({
          id: firstSession,
          started_at: DateTime.formatIso(yield* DateTime.now),
        })}`.pipe(Effect.orDie)

      const session = yield* SubscriptionRef.make(firstSession)

      const sessionLock = yield* Semaphore.make(1)

      const model = yield* SubscriptionRef.make<ModelChoice>({
        model: saved?.model ?? null,
        effort: saved?.effort ?? null,
      })

      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.orDie)

      const starting = yield* Semaphore.make(1)

      const callerOf = (sessionId: string) => GlobalChatCaller.make({ globalChatId: id, sessionId })

      const start = (sessionId: string) => (client: ThreadHost) =>
        starting.withPermits(1)(
          Effect.gen(function* () {
            const lifetime = yield* host.lifetimeOf(client).pipe(
              Effect.flatMap(Effect.fromOption),
              Effect.mapError(() => hostGone),
            )

            yield* credentials.startWith(lifetime, callerOf(sessionId), (tools) =>
              client.StartThread({
                threadId: sessionId,
                harness: "pi",
                folder,
                role: GlobalRole.make({ tools }),
                skills: [],
              }),
            )
          }),
        )

      const stopProgram = (sessionId: string) =>
        starting.withPermits(1)(
          Effect.gen(function* () {
            const running = yield* host.running

            if (Option.isSome(running))
              yield* boundHostCall(running.value.StopThread({ threadId: sessionId })).pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Couldn't stop pi for the ended Global chat", cause),
                ),
              )

            yield* credentials.revoke(callerOf(sessionId))
          }),
        )

      const threadOf = (sessionId: string) =>
        SubscriptionRef.get(model).pipe(
          Effect.map((choice): ClaimedThread => ({
            id: sessionId,
            ensureStarted: start(sessionId),
            settings: { ...choice, permissionMode: null },
            prepareHost: host.client,
            connectedHost: host.running,
          })),
        )

      const currentSession = SubscriptionRef.get(session)

      const thread = currentSession.pipe(Effect.flatMap(threadOf))

      const currentSessions = currentSession.pipe(Effect.map((sessionId) => [sessionId]))

      const inSession = <A, E>(effect: (sessionId: string) => Effect.Effect<A, E>) =>
        sessionLock.withPermits(1)(currentSession.pipe(Effect.flatMap(effect)))

      const inThread = <A, E>(effect: (current: ClaimedThread) => Effect.Effect<A, E>) =>
        inSession((sessionId) => threadOf(sessionId).pipe(Effect.flatMap(effect)))

      const followSession = <A, E>(stream: (sessionId: string) => Stream.Stream<A, E>) =>
        SubscriptionRef.changes(session).pipe(Stream.switchMap(stream))

      const dropSessionHoldingStaleCredential = host.resume.pipe(
        Effect.flatMap(({ reattached }) =>
          reattached ? currentSession.pipe(Effect.flatMap(stopProgram)) : Effect.void,
        ),
      )

      yield* turns.serve({
        claim: (threadId) =>
          thread.pipe(
            Effect.map((current) =>
              current.id === threadId ? Option.some(current) : Option.none(),
            ),
          ),
        lost: (yield* host.subscribeStopped).pipe(Stream.mapEffect(() => currentSessions)),
        interrupted: dropSessionHoldingStaleCredential.pipe(Effect.andThen(currentSessions)),
      })

      const changeModel = Effect.fn("GlobalChat.changeModel")(function* (choice: ModelChoice) {
        yield* stored(
          "save the Global chat's model",
          sql`
            UPDATE global_chat
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
            "start the Global chat fresh",
            sql.withTransaction(
              Effect.all(
                [
                  sql`UPDATE global_chat_session SET ended_at = ${at} WHERE id = ${ending}`,
                  sql`INSERT INTO global_chat_session ${sql.insert({ id: next, started_at: at })}`,
                ],
                { discard: true },
              ),
            ),
          )
          yield* SubscriptionRef.set(session, next)
          yield* annotateUnit({ thread_id: next })
        }),
      ).pipe(Effect.withSpan("GlobalChat.startFresh"))

      const endedSessions = stored(
        "read the Global chat's ended Sessions",
        sql`
          SELECT id, started_at AS startedAt, ended_at AS endedAt
          FROM global_chat_session WHERE ended_at IS NOT NULL ORDER BY started_at DESC
        `.pipe(Effect.flatMap(decodeEnded)),
      )

      const findSession = Effect.fnUntraced(function* (sessionId: string) {
        const [found] = yield* stored(
          "read a Global chat Session",
          sql`
            SELECT id FROM global_chat_session WHERE id = ${sessionId}
          `.pipe(Effect.flatMap(decodeIds)),
        )

        if (found === undefined) yield* new GlobalChatSessionNotFound({ id: sessionId })
      })

      return GlobalChat.of({
        model: SubscriptionRef.get(model),
        changeModel,
        transcript: followSession(transcripts.watch),
        loadEarlier: (before) =>
          inSession((sessionId) => transcripts.loadEarlier(sessionId, before)),
        send: (input) => inSession((sessionId) => turns.send(sessionId, input)).pipe(Effect.asVoid),
        steer: (input) => inThread((current) => turns.steer(current, input)),
        cancelQueued: (queuedId) =>
          inSession((sessionId) => transcripts.cancelQueued(sessionId, queuedId)),
        sendQueued: (queuedId) => inSession((sessionId) => turns.sendQueued(sessionId, queuedId)),
        stop: inThread(turns.stop),
        answer: (requestId, answer) =>
          inThread((current) => turns.answer(current, requestId, answer)),
        unsent: turns.unsent(id),
        saveUnsent: (unsent) => turns.saveUnsent(id, unsent),
        id,
        startFresh,
        endedSessions,
        watchSession: (sessionId) =>
          Stream.unwrap(findSession(sessionId).pipe(Effect.as(transcripts.watch(sessionId)))),
        loadEarlierInSession: (sessionId, before) =>
          findSession(sessionId).pipe(Effect.andThen(transcripts.loadEarlier(sessionId, before))),
        waiting: followSession((sessionId) =>
          transcripts.waiting.pipe(Stream.map((waiting) => waiting.get(sessionId) ?? [])),
        ),
        unseen: followSession((sessionId) =>
          transcripts.unseen.pipe(Stream.map((unseen) => unseen.get(sessionId)?.ended ?? null)),
        ).pipe(Stream.changesWith(Schema.toEquivalence(Schema.NullOr(TurnEnd)))),
        markSeen: (endedAt) => inSession((sessionId) => transcripts.markSeen(sessionId, endedAt)),
        whenIdle: (effect) => inSession((sessionId) => turns.whenIdle(sessionId, effect)),
      })
    }),
  )
}

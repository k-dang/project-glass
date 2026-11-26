import {
  type Turn,
  ThreadBusy,
  ThreadError,
  type FeedbackNote,
  isNothingUnsent,
  mentionedToDoIds,
  type MessageDelivery,
  type MessageWithContext,
  nothingUnsent,
  type RequestAnswer,
  type RequestNotWaiting,
  RequestWaiting,
  type SentMessage,
  ToDo,
  type TurnContext,
  withContextOf,
  TurnCutOff,
  TurnEnded,
  TurnFailed,
  TurnInterrupted,
  TurnStopped,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema, Scope, Stream } from "effect"
import { SqlClient } from "effect/sql"
import type { DeliveredTurn } from "./agentHost/deliveredMessage"
import type { TurnSettings } from "./agentHost/protocol"
import { boundHostCall } from "./hostControl"
import { keyedLock } from "./keyedLock"
import { type HostCallError, type HostClient, hostFailure } from "./Placement"
import { prompt } from "./prompt"
import { ToDos } from "./ToDos"
import { encodeImages, type IdleTurn, StoredMessage, Transcripts } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

type HostCall<Name extends keyof HostClient> = (
  input: Parameters<HostClient[Name]>[0],
) => ReturnType<HostClient[Name]>

export interface ThreadHost {
  readonly StartThread: HostCall<"StartThread">
  readonly StartTurn: HostCall<"StartTurn">
  readonly AnswerRequest: HostCall<"AnswerRequest">
  readonly Steer: HostCall<"Steer">
  readonly StopTurn: HostCall<"StopTurn">
  readonly StopBackgroundTask: HostCall<"StopBackgroundTask">
}

export interface ClaimedThread {
  readonly id: string
  readonly ensureStarted: (client: ThreadHost) => Effect.Effect<void, HostCallError>
  readonly settings: TurnSettings
  readonly prepareHost: Effect.Effect<ThreadHost, ThreadError>
  readonly connectedHost: Effect.Effect<Option.Option<ThreadHost>>
}

type ClaimThread = (threadId: string) => Effect.Effect<Option.Option<ClaimedThread>, ThreadError>

interface Served {
  readonly claim: ClaimThread
  readonly lost: Stream.Stream<ReadonlyArray<string>>
  readonly interrupted: Effect.Effect<ReadonlyArray<string>>
}

export type Delivery = "dispatched" | "superseded" | "failed" | "pending"

export type StartIdle = (
  turn: IdleTurn,
  record: (turnId: string) => Effect.Effect<void, ThreadError>,
) => Effect.Effect<void, ThreadError>

type StartedMessage = Pick<Turn, "message" | "images" | "context" | "feedback">

interface Prepared {
  readonly client: ThreadHost
  readonly message: DeliveredTurn
}

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const unsentFailure = () =>
  new ThreadError({ message: "Couldn't read or save your unsent message. Try again." })

const stopHost = (thread: ClaimedThread, turnId: string) =>
  thread.connectedHost.pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.succeed(null)
        : boundHostCall(running.value.StopTurn({ threadId: thread.id, turnId })).pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't stop a Turn", cause)),
            Effect.orElseSucceed(() => null),
          ),
    ),
  )

export class ThreadTurns extends Context.Service<
  ThreadTurns,
  {
    readonly serve: (threads: Served) => Effect.Effect<void>
    readonly whileIdle: <A, E>(
      threadId: string,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ThreadBusy | ThreadError>
    readonly send: (
      threadId: string,
      message: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ThreadError>,
    ) => Effect.Effect<MessageDelivery, RequestWaiting | ThreadError>
    readonly steer: (
      thread: ClaimedThread,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | ThreadError>
    readonly whenIdle: <E>(
      threadId: string,
      effect: (start: StartIdle) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | ThreadError>
    readonly sendQueued: (
      threadId: string,
      queuedId: string,
    ) => Effect.Effect<void, ThreadBusy | ThreadError>
    readonly stop: (thread: ClaimedThread) => Effect.Effect<void, ThreadError>
    readonly stopBackgroundTask: (
      thread: ClaimedThread,
      taskId: string,
    ) => Effect.Effect<void, ThreadError>
    readonly answer: (
      thread: ClaimedThread,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | ThreadError>
    readonly unsent: (threadId: string) => Effect.Effect<SentMessage, ThreadError>
    readonly saveUnsent: (threadId: string, unsent: SentMessage) => Effect.Effect<void, ThreadError>
    readonly removeUnsent: (threadId: string) => Effect.Effect<void, ThreadError>
  }
>()("@glass/server/ThreadTurns") {
  static readonly layer = Layer.effect(
    ThreadTurns,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const toDos = yield* ToDos
      const scope = yield* Scope.Scope
      const withThread = keyedLock().withLock

      const delivered = Effect.fnUntraced(function* <Context extends TurnContext>(
        sent: SentMessage & { readonly context: Context | null },
        feedback: ReadonlyArray<FeedbackNote> = [],
      ) {
        if (Predicate.isTagged(sent.context, "AgentReview"))
          return { ...withContextOf(sent), mentionedImages: [], prompt: sent.message }

        const ids = mentionedToDoIds(sent.message)

        const listed =
          ids.length === 0
            ? []
            : yield* toDos.list().pipe(
                Effect.tapError((cause) =>
                  Effect.logWarning("Couldn't read mentioned To-dos", cause),
                ),
                Effect.orElseSucceed(() => []),
              )

        const found = ids.flatMap((id) => listed.find((toDo) => toDo.id === id) ?? [])

        const mentioned = yield* Effect.forEach(
          found,
          (toDo) =>
            Effect.forEach(toDo.images, ({ id }) => toDos.readImage(id, "full"), {
              concurrency: "unbounded",
            }).pipe(
              Effect.map((images) => ({ toDo, images })),
              Effect.tapError((cause) =>
                Effect.logWarning("Couldn't read a mentioned To-do's images", cause),
              ),
              Effect.orElseSucceed(() => {
                const { id, title, notes, done } = toDo

                return { toDo: new ToDo({ id, title, notes, done, images: [] }), images: [] }
              }),
            ),
          { concurrency: "unbounded" },
        )

        return {
          ...withContextOf(sent),
          mentionedImages: mentioned.flatMap(({ images }) => images),
          prompt: prompt(
            sent.message,
            mentioned.map(({ toDo }) => toDo),
            sent.context,
            feedback,
          ),
        }
      })

      const prepare = (thread: ClaimedThread, sent: StartedMessage) =>
        Effect.gen(function* () {
          const client = yield* thread.prepareHost

          const [, message] = yield* Effect.all(
            [thread.ensureStarted(client), delivered(sent, sent.feedback)],
            { concurrency: "unbounded" },
          )

          return { client, message } satisfies Prepared
        })

      const failTurn = (threadId: string, turnId: string, reason: string) =>
        Effect.gen(function* () {
          const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

          yield* transcripts.save(threadId, [TurnEnded.make({ turnId, ended })])
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Couldn't fail an undelivered Turn", cause)),
          Effect.as("failed" as const satisfies Delivery),
        )

      const settleUndelivered = (thread: ClaimedThread, turnId: string, error: HostCallError) =>
        Effect.yieldNow.pipe(
          Effect.andThen(transcripts.settleUndelivered(thread.id, turnId, hostFailure(error))),
          Effect.catch((cause) =>
            Effect.logWarning("Couldn't settle an undelivered Turn", cause).pipe(
              Effect.as("failed" as const satisfies Delivery),
            ),
          ),
        )

      const dispatch = (thread: ClaimedThread, turnId: string, { client, message }: Prepared) =>
        Effect.gen(function* () {
          const threadId = thread.id

          const ownsTurn = yield* withThread(
            threadId,
            transcripts.runningTurn(threadId).pipe(Effect.map((running) => running === turnId)),
          )

          if (!ownsTurn) return "superseded" as const satisfies Delivery

          const started = yield* boundHostCall(
            client.StartTurn({ threadId, turnId, ...message, ...thread.settings }),
          ).pipe(
            Effect.as("accepted" as const),
            Effect.catch((error) => Effect.succeed(error)),
          )

          return yield* withThread(
            threadId,
            Effect.gen(function* () {
              const still = (yield* transcripts.runningTurn(threadId)) === turnId

              if (started === "accepted") {
                if (!still) yield* stopHost(thread, turnId)

                return still
                  ? ("dispatched" as const satisfies Delivery)
                  : ("superseded" as const satisfies Delivery)
              }

              if (!still) {
                yield* stopHost(thread, turnId)

                return "superseded" as const satisfies Delivery
              }

              const settled = yield* settleUndelivered(thread, turnId, started)

              yield* stopHost(thread, turnId)

              return settled
            }),
          )
        })

      const deliver = (thread: ClaimedThread, turnId: string, sent: StartedMessage) =>
        prepare(thread, sent).pipe(
          Effect.flatMap((prepared) => dispatch(thread, turnId, prepared)),
          Effect.catch((error) => settleUndelivered(thread, turnId, error)),
          Effect.tap((delivery) =>
            annotateUnit({ thread_id: thread.id, turn_id: turnId, delivery }),
          ),
          Effect.withSpan("ThreadTurns.deliver", { root: true }),
        )

      const serve = Effect.fnUntraced(function* ({ claim, lost, interrupted }: Served) {
        yield* lost.pipe(
          Stream.runForEach((threadIds) =>
            transcripts
              .endRunning(TurnCutOff.make({}), threadIds)
              .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off Turns", cause))),
          ),
          Effect.forkIn(scope),
        )

        const started = yield* transcripts.subscribeStarted.pipe(Scope.provide(scope))

        const interruptedIds = yield* interrupted

        const retried = yield* transcripts.retryDeliveries(interruptedIds).pipe(Effect.orDie)

        yield* Stream.merge(Stream.fromIterable(retried), started).pipe(
          Stream.runForEach(({ threadId, turnId, message, images, context, feedback }) =>
            claim(threadId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (thread) =>
                    deliver(thread, turnId, { message, images, context, feedback }).pipe(
                      Effect.forkIn(scope),
                      Effect.asVoid,
                    ),
                }),
              ),
              Effect.catch((error) => failTurn(threadId, turnId, error.message)),
            ),
          ),
          Effect.forkIn(scope),
        )

        yield* transcripts.endRunning(TurnInterrupted.make({}), interruptedIds).pipe(Effect.orDie)
      })

      const refuseWhileWaiting = (threadId: string) =>
        transcripts
          .isWaiting(threadId)
          .pipe(Effect.flatMap((waiting) => (waiting ? new RequestWaiting() : Effect.void)))

      const trySteer = (thread: ClaimedThread, sent: MessageWithContext) =>
        Effect.gen(function* () {
          const threadId = thread.id

          if ((yield* transcripts.runningTurn(threadId)) === null) return false

          const running = yield* thread.connectedHost

          if (Option.isNone(running)) return false

          const message = yield* delivered(sent)

          return yield* boundHostCall(running.value.Steer({ threadId, ...message })).pipe(
            Effect.as(true),
            Effect.tapError((cause) => Effect.logWarning("Couldn't Steer a Turn", cause)),
            Effect.catch((error) =>
              Predicate.isTagged(error, "ThreadError") ? Effect.fail(error) : Effect.succeed(false),
            ),
          )
        })

      const stop = Effect.fn("ThreadTurns.stop")(function* (thread: ClaimedThread) {
        const threadId = thread.id

        yield* withThread(
          threadId,
          Effect.gen(function* () {
            const runningId = yield* transcripts.runningTurn(threadId)

            if (runningId === null) return

            yield* transcripts.askedToStop(runningId)

            const left = yield* stopHost(thread, runningId)

            if (left === null) yield* transcripts.endRunning(TurnStopped.make({}), [threadId])
            else if (left.length > 0) yield* transcripts.prependQueued(threadId, left)
          }),
        )
      })

      const stopBackgroundTask = Effect.fn("ThreadTurns.stopBackgroundTask")(function* (
        thread: ClaimedThread,
        taskId: string,
      ) {
        const running = yield* thread.connectedHost

        if (Option.isNone(running))
          return yield* new ThreadError({
            message: "Glass can't reach this Thread's agent to stop that task. Try again.",
          })

        return yield* boundHostCall(
          running.value.StopBackgroundTask({ threadId: thread.id, taskId }),
        ).pipe(Effect.mapError((error) => new ThreadError({ message: hostFailure(error) })))
      })

      const answer = Effect.fn("ThreadTurns.answer")(function* (
        thread: ClaimedThread,
        requestId: string,
        given: RequestAnswer,
      ) {
        return yield* thread.prepareHost.pipe(
          Effect.flatMap((client) =>
            boundHostCall(client.AnswerRequest({ threadId: thread.id, requestId, answer: given })),
          ),
          Effect.mapError((error) =>
            Predicate.isTagged(error, "RequestNotWaiting")
              ? error
              : new ThreadError({ message: hostFailure(error) }),
          ),
        )
      })

      const unsent = Effect.fn("ThreadTurns.unsent")(function* (threadId: string) {
        const [saved] = yield* sql`
          SELECT message, images FROM thread_unsent_message WHERE thread_id = ${threadId}
        `.pipe(
          Effect.flatMap(decodeUnsent),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read an unsent message", cause)),
          Effect.mapError(unsentFailure),
        )

        return saved ?? nothingUnsent
      })

      const saveUnsent = Effect.fn("ThreadTurns.saveUnsent")(function* (
        threadId: string,
        { message, images }: SentMessage,
      ) {
        yield* (
          isNothingUnsent({ message, images })
            ? sql`DELETE FROM thread_unsent_message WHERE thread_id = ${threadId}`
            : sql`
                INSERT INTO thread_unsent_message ${sql.insert({
                  thread_id: threadId,
                  message,
                  images: encodeImages(images),
                })}
                ON CONFLICT (thread_id) DO UPDATE SET message = excluded.message, images = excluded.images
              `
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save an unsent message", cause)),
          Effect.mapError(unsentFailure),
        )
      })

      const startOrQueue = (
        threadId: string,
        sent: MessageWithContext,
        feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ThreadError>,
      ) => withThread(threadId, transcripts.startOrQueue(threadId, sent, feedback))

      const turns = ThreadTurns.of({
        serve,
        whileIdle: (threadId, effect) =>
          withThread(
            threadId,
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(threadId)) !== null)
                return yield* new ThreadBusy()

              return yield* effect
            }),
          ),
        send: Effect.fn("ThreadTurns.send")(function* (threadId, sent, feedback) {
          yield* refuseWhileWaiting(threadId)

          return yield* startOrQueue(threadId, sent, feedback)
        }),
        steer: Effect.fn("ThreadTurns.steer")(function* (thread, sent) {
          yield* refuseWhileWaiting(thread.id)

          if (!(yield* trySteer(thread, sent))) yield* startOrQueue(thread.id, sent)
        }),
        whenIdle: (threadId, effect) =>
          withThread(
            threadId,
            Effect.gen(function* () {
              if (!(yield* transcripts.idle(threadId))) return

              yield* effect((turn, record) => transcripts.startIfIdle(threadId, turn, record))
            }),
          ),
        sendQueued: (threadId, queuedId) =>
          withThread(threadId, transcripts.startQueued(threadId, queuedId)),
        stop,
        stopBackgroundTask,
        answer,
        unsent,
        saveUnsent,
        removeUnsent: (threadId) =>
          sql`DELETE FROM thread_unsent_message WHERE thread_id = ${threadId}`.pipe(
            Effect.asVoid,
            Effect.mapError(unsentFailure),
          ),
      })

      return turns
    }),
  )
}

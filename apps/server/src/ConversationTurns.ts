import {
  type Turn,
  ConversationBusy,
  ConversationError,
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
  type GlobalConversationUpdate,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect"
import { SqlClient } from "effect/sql"
import type { DeliveredTurn } from "./agentHost/deliveredMessage"
import type { TurnSettings } from "./agentHost/protocol"
import { boundHostCall } from "./hostControl"
import { type HostCallError, type HostClient, hostFailure } from "./Placement"
import { prompt } from "./prompt"
import { ToDos } from "./ToDos"
import { encodeImages, StoredMessage, Transcripts } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

type HostCall<Name extends keyof HostClient> = (
  input: Parameters<HostClient[Name]>[0],
) => ReturnType<HostClient[Name]>

export interface ConversationHost {
  readonly StartConversation: HostCall<"StartConversation">
  readonly StartTurn: HostCall<"StartTurn">
  readonly AnswerRequest: HostCall<"AnswerRequest">
  readonly Steer: HostCall<"Steer">
  readonly StopTurn: HostCall<"StopTurn">
}

export interface ClaimedConversation {
  readonly id: string
  readonly ensureStarted: (client: ConversationHost) => Effect.Effect<void, HostCallError>
  readonly settings: TurnSettings
  readonly host: Effect.Effect<ConversationHost, ConversationError>
  readonly runningHost: Effect.Effect<Option.Option<ConversationHost>>
}

export type ClaimConversation = (
  conversationId: string,
) => Effect.Effect<Option.Option<ClaimedConversation>, ConversationError>

export interface Served {
  readonly claim: ClaimConversation
  readonly lost: Stream.Stream<ReadonlyArray<string>>
  readonly interrupted: Effect.Effect<ReadonlyArray<string>>
}

export type Delivery = "dispatched" | "superseded" | "failed" | "pending"

type StartedMessage = Pick<Turn, "message" | "images" | "context" | "feedback">

interface Prepared {
  readonly client: ConversationHost
  readonly message: DeliveredTurn
}

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const unsentFailure = () =>
  new ConversationError({ message: "Couldn't read or save your unsent message. Try again." })

const stopHost = (conversation: ClaimedConversation, turnId: string) =>
  conversation.runningHost.pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.succeed(null)
        : boundHostCall(running.value.StopTurn({ conversationId: conversation.id, turnId })).pipe(
            Effect.tapError((cause) => Effect.logWarning("Couldn't stop a Turn", cause)),
            Effect.orElseSucceed(() => null),
          ),
    ),
  )

export class ConversationTurns extends Context.Service<
  ConversationTurns,
  {
    readonly serve: (conversations: Served) => Effect.Effect<void>
    readonly whileIdle: <A, E>(
      conversationId: string,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ConversationBusy | ConversationError>
    readonly send: (
      conversationId: string,
      message: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>,
    ) => Effect.Effect<MessageDelivery, RequestWaiting | ConversationError>
    readonly steer: (
      conversation: ClaimedConversation,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | ConversationError>
    readonly whenIdle: <E>(
      conversationId: string,
      effect: (
        start: (
          globalConversationUpdate: GlobalConversationUpdate,
          record: (turnId: string) => Effect.Effect<void, ConversationError>,
        ) => Effect.Effect<void, ConversationError>,
      ) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | ConversationError>
    readonly sendQueued: (
      conversationId: string,
      queuedId: string,
    ) => Effect.Effect<void, ConversationBusy | ConversationError>
    readonly stop: (conversation: ClaimedConversation) => Effect.Effect<void, ConversationError>
    readonly answer: (
      conversation: ClaimedConversation,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | ConversationError>
    readonly unsent: (conversationId: string) => Effect.Effect<SentMessage, ConversationError>
    readonly saveUnsent: (
      conversationId: string,
      unsent: SentMessage,
    ) => Effect.Effect<void, ConversationError>
    readonly removeUnsent: (conversationId: string) => Effect.Effect<void, ConversationError>
  }
>()("@glass/server/ConversationTurns") {
  static readonly layer = Layer.effect(
    ConversationTurns,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const toDos = yield* ToDos
      const scope = yield* Scope.Scope
      const locks = new Map<string, { semaphore: Semaphore.Semaphore; holders: number }>()

      const withConversation = <A, E, R>(conversationId: string, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          const lock = locks.get(conversationId) ?? {
            semaphore: Semaphore.makeUnsafe(1),
            holders: 0,
          }

          lock.holders += 1
          locks.set(conversationId, lock)

          return lock.semaphore
            .withPermits(1)(effect)
            .pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  lock.holders -= 1

                  if (lock.holders === 0 && locks.get(conversationId) === lock)
                    locks.delete(conversationId)
                }),
              ),
            )
        })

      const delivered = Effect.fnUntraced(function* <Context extends TurnContext>(
        sent: SentMessage & { readonly context: Context | null },
        feedback: ReadonlyArray<FeedbackNote> = [],
      ) {
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

      const prepare = (conversation: ClaimedConversation, sent: StartedMessage) =>
        Effect.gen(function* () {
          const client = yield* conversation.host

          const [, message] = yield* Effect.all(
            [conversation.ensureStarted(client), delivered(sent, sent.feedback)],
            { concurrency: "unbounded" },
          )

          return { client, message } satisfies Prepared
        })

      const failTurn = (conversationId: string, turnId: string, reason: string) =>
        Effect.gen(function* () {
          const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

          yield* transcripts.save(conversationId, [TurnEnded.make({ turnId, ended })])
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Couldn't fail an undelivered Turn", cause)),
          Effect.as("failed" as const satisfies Delivery),
        )

      const settleUndelivered = (
        conversation: ClaimedConversation,
        turnId: string,
        context: StartedMessage["context"],
        error: HostCallError,
      ) =>
        Effect.gen(function* () {
          yield* Effect.yieldNow

          if (Predicate.isTagged(context, "GlobalConversationUpdate"))
            return yield* transcripts
              .setStatus(conversation.id, hostFailure(error))
              .pipe(Effect.as("pending" as const satisfies Delivery))

          return yield* failTurn(conversation.id, turnId, hostFailure(error))
        })

      const dispatch = (
        conversation: ClaimedConversation,
        turnId: string,
        { client, message }: Prepared,
      ) =>
        Effect.gen(function* () {
          const conversationId = conversation.id

          const ownsTurn = yield* withConversation(
            conversationId,
            transcripts
              .runningTurn(conversationId)
              .pipe(Effect.map((running) => running === turnId)),
          )

          if (!ownsTurn) return "superseded" as const satisfies Delivery

          const started = yield* boundHostCall(
            client.StartTurn({ conversationId, turnId, ...message, ...conversation.settings }),
          ).pipe(
            Effect.as("accepted" as const),
            Effect.catch((error) => Effect.succeed(error)),
          )

          return yield* withConversation(
            conversationId,
            Effect.gen(function* () {
              const still = (yield* transcripts.runningTurn(conversationId)) === turnId

              if (started === "accepted") {
                if (!still) yield* stopHost(conversation, turnId)

                return still
                  ? ("dispatched" as const satisfies Delivery)
                  : ("superseded" as const satisfies Delivery)
              }

              if (!still) {
                yield* stopHost(conversation, turnId)

                return "superseded" as const satisfies Delivery
              }

              const settled = yield* settleUndelivered(
                conversation,
                turnId,
                message.context,
                started,
              )

              yield* stopHost(conversation, turnId)

              return settled
            }),
          )
        })

      const deliver = (conversation: ClaimedConversation, turnId: string, sent: StartedMessage) =>
        prepare(conversation, sent).pipe(
          Effect.flatMap((prepared) => dispatch(conversation, turnId, prepared)),
          Effect.catch((error) => settleUndelivered(conversation, turnId, sent.context, error)),
          Effect.tap((delivery) =>
            annotateUnit({ conversation_id: conversation.id, turn_id: turnId, delivery }),
          ),
          Effect.withSpan("ConversationTurns.deliver", { root: true }),
        )

      const serve = Effect.fnUntraced(function* ({ claim, lost, interrupted }: Served) {
        yield* lost.pipe(
          Stream.runForEach((conversationIds) =>
            transcripts
              .endRunning(TurnCutOff.make({}), conversationIds)
              .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off Turns", cause))),
          ),
          Effect.forkIn(scope),
        )

        const started = yield* transcripts.subscribeStarted.pipe(Scope.provide(scope))

        const interruptedIds = yield* interrupted

        const recovered = yield* transcripts
          .recoverGlobalConversationUpdates(interruptedIds)
          .pipe(Effect.orDie)

        yield* Stream.merge(Stream.fromIterable(recovered), started).pipe(
          Stream.runForEach(({ conversationId, turnId, message, images, context, feedback }) =>
            claim(conversationId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (conversation) =>
                    deliver(conversation, turnId, { message, images, context, feedback }).pipe(
                      Effect.forkIn(scope),
                      Effect.asVoid,
                    ),
                }),
              ),
              Effect.catch((error) => failTurn(conversationId, turnId, error.message)),
            ),
          ),
          Effect.forkIn(scope),
        )

        yield* transcripts
          .endRunning(
            TurnInterrupted.make({}),
            interruptedIds.filter(
              (id) => !recovered.some(({ conversationId }) => conversationId === id),
            ),
          )
          .pipe(Effect.orDie)
      })

      const refuseWhileWaiting = (conversationId: string) =>
        transcripts
          .isWaiting(conversationId)
          .pipe(Effect.flatMap((waiting) => (waiting ? new RequestWaiting() : Effect.void)))

      const trySteer = (conversation: ClaimedConversation, sent: MessageWithContext) =>
        Effect.gen(function* () {
          const conversationId = conversation.id

          if ((yield* transcripts.runningTurn(conversationId)) === null) return false

          const running = yield* conversation.runningHost

          if (Option.isNone(running)) return false

          const message = yield* delivered(sent)

          return yield* boundHostCall(running.value.Steer({ conversationId, ...message })).pipe(
            Effect.as(true),
            Effect.tapError((cause) => Effect.logWarning("Couldn't Steer a Turn", cause)),
            Effect.catch((error) =>
              Predicate.isTagged(error, "ConversationError")
                ? Effect.fail(error)
                : Effect.succeed(false),
            ),
          )
        })

      const stop = Effect.fn("ConversationTurns.stop")(function* (
        conversation: ClaimedConversation,
      ) {
        const conversationId = conversation.id

        yield* withConversation(
          conversationId,
          Effect.gen(function* () {
            const runningId = yield* transcripts.runningTurn(conversationId)

            if (runningId === null) return

            yield* transcripts.askedToStop(runningId)

            const left = yield* stopHost(conversation, runningId)

            if (left === null) yield* transcripts.endRunning(TurnStopped.make({}), [conversationId])
            else if (left.length > 0) yield* transcripts.prependQueued(conversationId, left)
          }),
        )
      })

      const answer = Effect.fn("ConversationTurns.answer")(function* (
        conversation: ClaimedConversation,
        requestId: string,
        given: RequestAnswer,
      ) {
        return yield* conversation.host.pipe(
          Effect.flatMap((client) =>
            boundHostCall(
              client.AnswerRequest({ conversationId: conversation.id, requestId, answer: given }),
            ),
          ),
          Effect.mapError((error) =>
            Predicate.isTagged(error, "RequestNotWaiting")
              ? error
              : new ConversationError({ message: hostFailure(error) }),
          ),
        )
      })

      const unsent = Effect.fn("ConversationTurns.unsent")(function* (conversationId: string) {
        const [saved] = yield* sql`
          SELECT message, images FROM conversation_unsent_message WHERE conversation_id = ${conversationId}
        `.pipe(
          Effect.flatMap(decodeUnsent),
          Effect.tapError((cause) => Effect.logWarning("Couldn't read an unsent message", cause)),
          Effect.mapError(unsentFailure),
        )

        return saved ?? nothingUnsent
      })

      const saveUnsent = Effect.fn("ConversationTurns.saveUnsent")(function* (
        conversationId: string,
        { message, images }: SentMessage,
      ) {
        yield* (
          isNothingUnsent({ message, images })
            ? sql`DELETE FROM conversation_unsent_message WHERE conversation_id = ${conversationId}`
            : sql`
                INSERT INTO conversation_unsent_message ${sql.insert({
                  conversation_id: conversationId,
                  message,
                  images: encodeImages(images),
                })}
                ON CONFLICT (conversation_id) DO UPDATE SET message = excluded.message, images = excluded.images
              `
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save an unsent message", cause)),
          Effect.mapError(unsentFailure),
        )
      })

      const startOrQueue = (
        conversationId: string,
        sent: MessageWithContext,
        feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>,
      ) =>
        withConversation(conversationId, transcripts.startOrQueue(conversationId, sent, feedback))

      const turns = ConversationTurns.of({
        serve,
        whileIdle: (conversationId, effect) =>
          withConversation(
            conversationId,
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(conversationId)) !== null)
                return yield* new ConversationBusy()

              return yield* effect
            }),
          ),
        send: Effect.fn("ConversationTurns.send")(function* (conversationId, sent, feedback) {
          yield* refuseWhileWaiting(conversationId)

          return yield* startOrQueue(conversationId, sent, feedback)
        }),
        steer: Effect.fn("ConversationTurns.steer")(function* (conversation, sent) {
          yield* refuseWhileWaiting(conversation.id)

          if (!(yield* trySteer(conversation, sent))) yield* startOrQueue(conversation.id, sent)
        }),
        whenIdle: (conversationId, effect) =>
          withConversation(
            conversationId,
            Effect.gen(function* () {
              if (!(yield* transcripts.idle(conversationId))) return

              yield* effect((globalConversationUpdate, record) =>
                transcripts.startGlobalConversationUpdate(
                  conversationId,
                  globalConversationUpdate,
                  record,
                ),
              )
            }),
          ),
        sendQueued: (conversationId, queuedId) =>
          withConversation(conversationId, transcripts.startQueued(conversationId, queuedId)),
        stop,
        answer,
        unsent,
        saveUnsent,
        removeUnsent: (conversationId) =>
          sql`DELETE FROM conversation_unsent_message WHERE conversation_id = ${conversationId}`.pipe(
            Effect.asVoid,
            Effect.mapError(unsentFailure),
          ),
      })

      return turns
    }),
  )
}

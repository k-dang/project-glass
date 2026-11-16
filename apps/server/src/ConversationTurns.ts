import {
  type Turn,
  AgentBusy,
  AgentError,
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
  readonly StartAgent: HostCall<"StartAgent">
  readonly StartTurn: HostCall<"StartTurn">
  readonly AnswerRequest: HostCall<"AnswerRequest">
  readonly Steer: HostCall<"Steer">
  readonly StopTurn: HostCall<"StopTurn">
}

export interface Conversation {
  readonly id: string
  readonly ensureStarted: (client: ConversationHost) => Effect.Effect<void, HostCallError>
  readonly settings: TurnSettings
  readonly host: Effect.Effect<ConversationHost, AgentError>
  readonly runningHost: Effect.Effect<Option.Option<ConversationHost>>
}

export type ClaimConversation = (
  conversationId: string,
) => Effect.Effect<Option.Option<Conversation>, AgentError>

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
  new AgentError({ message: "Couldn't read or save your unsent message. Try again." })

const stopHost = (conversation: Conversation) =>
  conversation.runningHost.pipe(
    Effect.flatMap((running) =>
      Option.isNone(running)
        ? Effect.succeed(null)
        : boundHostCall(running.value.StopTurn({ agentId: conversation.id })).pipe(
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
    ) => Effect.Effect<A, E | AgentBusy | AgentError>
    readonly send: (
      conversationId: string,
      message: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>,
    ) => Effect.Effect<MessageDelivery, RequestWaiting | AgentError>
    readonly steer: (
      conversation: Conversation,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly whenIdle: <E>(
      conversationId: string,
      effect: (
        start: (
          globalConversationUpdate: GlobalConversationUpdate,
          record: (turnId: string) => Effect.Effect<void, AgentError>,
        ) => Effect.Effect<void, AgentError>,
      ) => Effect.Effect<void, E>,
    ) => Effect.Effect<void, E | AgentError>
    readonly sendQueued: (
      conversationId: string,
      queuedId: string,
    ) => Effect.Effect<void, AgentBusy | AgentError>
    readonly stop: (conversation: Conversation) => Effect.Effect<void, AgentError>
    readonly answer: (
      conversation: Conversation,
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | AgentError>
    readonly unsent: (conversationId: string) => Effect.Effect<SentMessage, AgentError>
    readonly saveUnsent: (
      conversationId: string,
      unsent: SentMessage,
    ) => Effect.Effect<void, AgentError>
    readonly removeUnsent: (conversationId: string) => Effect.Effect<void, AgentError>
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

        const mentioned = ids.flatMap((id) => listed.find((toDo) => toDo.id === id) ?? [])

        return {
          ...withContextOf(sent),
          prompt: prompt(sent.message, mentioned, sent.context, feedback),
        }
      })

      const prepare = (conversation: Conversation, sent: StartedMessage) =>
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
        conversation: Conversation,
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
        conversation: Conversation,
        turnId: string,
        { client, message }: Prepared,
      ) =>
        Effect.gen(function* () {
          const agentId = conversation.id

          const ownsTurn = yield* withConversation(
            agentId,
            transcripts.runningTurn(agentId).pipe(Effect.map((running) => running === turnId)),
          )

          if (!ownsTurn) return "superseded" as const satisfies Delivery

          const started = yield* boundHostCall(
            client.StartTurn({ agentId, turnId, ...message, ...conversation.settings }),
          ).pipe(
            Effect.as("accepted" as const),
            Effect.catch((error) => Effect.succeed(error)),
          )

          return yield* withConversation(
            agentId,
            Effect.gen(function* () {
              const still = (yield* transcripts.runningTurn(agentId)) === turnId

              if (started === "accepted") {
                if (!still) yield* stopHost(conversation)

                return still
                  ? ("dispatched" as const satisfies Delivery)
                  : ("superseded" as const satisfies Delivery)
              }

              if (!still) {
                yield* stopHost(conversation)

                return "superseded" as const satisfies Delivery
              }

              const settled = yield* settleUndelivered(
                conversation,
                turnId,
                message.context,
                started,
              )

              yield* stopHost(conversation)

              return settled
            }),
          )
        })

      const deliver = (conversation: Conversation, turnId: string, sent: StartedMessage) =>
        prepare(conversation, sent).pipe(
          Effect.flatMap((prepared) => dispatch(conversation, turnId, prepared)),
          Effect.catch((error) => settleUndelivered(conversation, turnId, sent.context, error)),
          Effect.tap((delivery) =>
            annotateUnit({ agent_id: conversation.id, turn_id: turnId, delivery }),
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
          Stream.runForEach(({ agentId, turnId, message, images, context, feedback }) =>
            claim(agentId).pipe(
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
              Effect.catch((error) => failTurn(agentId, turnId, error.message)),
            ),
          ),
          Effect.forkIn(scope),
        )

        yield* transcripts
          .endRunning(
            TurnInterrupted.make({}),
            interruptedIds.filter((id) => !recovered.some(({ agentId }) => agentId === id)),
          )
          .pipe(Effect.orDie)
      })

      const refuseWhileWaiting = (conversationId: string) =>
        transcripts
          .isWaiting(conversationId)
          .pipe(Effect.flatMap((waiting) => (waiting ? new RequestWaiting() : Effect.void)))

      const trySteer = (conversation: Conversation, sent: MessageWithContext) =>
        Effect.gen(function* () {
          const agentId = conversation.id

          if ((yield* transcripts.runningTurn(agentId)) === null) return false

          const running = yield* conversation.runningHost

          if (Option.isNone(running)) return false

          const message = yield* delivered(sent)

          return yield* boundHostCall(running.value.Steer({ agentId, ...message })).pipe(
            Effect.as(true),
            Effect.tapError((cause) => Effect.logWarning("Couldn't Steer a Turn", cause)),
            Effect.orElseSucceed(() => false),
          )
        })

      const stop = Effect.fn("ConversationTurns.stop")(function* (conversation: Conversation) {
        const agentId = conversation.id

        yield* withConversation(
          agentId,
          Effect.gen(function* () {
            const runningId = yield* transcripts.runningTurn(agentId)
            const left = yield* stopHost(conversation)

            if (runningId === null) return

            if (left === null) yield* transcripts.endRunning(TurnStopped.make({}), [agentId])
            else if (left.length > 0) yield* transcripts.prependQueued(agentId, left)
          }),
        )
      })

      const answer = Effect.fn("ConversationTurns.answer")(function* (
        conversation: Conversation,
        requestId: string,
        given: RequestAnswer,
      ) {
        return yield* conversation.host.pipe(
          Effect.flatMap((client) =>
            boundHostCall(
              client.AnswerRequest({ agentId: conversation.id, requestId, answer: given }),
            ),
          ),
          Effect.mapError((error) =>
            Predicate.isTagged(error, "RequestNotWaiting")
              ? error
              : new AgentError({ message: hostFailure(error) }),
          ),
        )
      })

      const unsent = Effect.fn("ConversationTurns.unsent")(function* (conversationId: string) {
        const [saved] = yield* sql`
          SELECT message, images FROM agent_unsent_message WHERE agent_id = ${conversationId}
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
            ? sql`DELETE FROM agent_unsent_message WHERE agent_id = ${conversationId}`
            : sql`
                INSERT INTO agent_unsent_message ${sql.insert({
                  agent_id: conversationId,
                  message,
                  images: encodeImages(images),
                })}
                ON CONFLICT (agent_id) DO UPDATE SET message = excluded.message, images = excluded.images
              `
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save an unsent message", cause)),
          Effect.mapError(unsentFailure),
        )
      })

      const startOrQueue = (
        conversationId: string,
        sent: MessageWithContext,
        feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>,
      ) =>
        withConversation(conversationId, transcripts.startOrQueue(conversationId, sent, feedback))

      const turns = ConversationTurns.of({
        serve,
        whileIdle: (conversationId, effect) =>
          withConversation(
            conversationId,
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(conversationId)) !== null)
                return yield* new AgentBusy()

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
          sql`DELETE FROM agent_unsent_message WHERE agent_id = ${conversationId}`.pipe(
            Effect.asVoid,
            Effect.mapError(unsentFailure),
          ),
      })

      coordination.set(turns, locks)

      return turns
    }),
  )
}

interface TurnOwner {
  readonly removeUnsent: (conversationId: string) => Effect.Effect<void, AgentError>
}

const coordination = new WeakMap<
  TurnOwner,
  Map<string, { semaphore: Semaphore.Semaphore; holders: number }>
>()

export const conversationLock = (owner: TurnOwner, conversationId: string): object | undefined =>
  coordination.get(owner)?.get(conversationId)

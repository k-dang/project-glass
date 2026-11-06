import {
  AgentBusy,
  AgentError,
  isNothingUnsent,
  mentionedToDoIds,
  type MessageDelivery,
  type MessageWithContext,
  nothingUnsent,
  type RequestAnswer,
  type RequestNotWaiting,
  RequestWaiting,
  type SentMessage,
  TurnEnded,
  TurnFailed,
  TurnStopped,
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
import type { DeliveredMessage } from "./agentHost/deliveredMessage"
import type { TurnSettings } from "./agentHost/protocol"
import { type HostCallError, type HostClient, hostFailure } from "./Placement"
import { prompt } from "./prompt"
import { ToDos } from "./ToDos"
import { encodeImages, StoredMessage, Transcripts } from "./Transcripts"

export interface Conversation {
  readonly id: string
  /** Starts the conversation's program on `client` unless it is already running there. */
  readonly start: (client: HostClient) => Effect.Effect<void, HostCallError>
  readonly settings: TurnSettings
  readonly host: Effect.Effect<HostClient, AgentError>
  readonly runningHost: Effect.Effect<Option.Option<HostClient>>
}

export type ClaimConversation = (
  conversationId: string,
) => Effect.Effect<Option.Option<Conversation>, AgentError>

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const unsentFailure = () =>
  new AgentError({ message: "Couldn't read or save your unsent message. Try again." })

export class ConversationTurns extends Context.Service<
  ConversationTurns,
  {
    readonly deliverTurnsOf: (claim: ClaimConversation) => Effect.Effect<void>
    readonly whileIdle: <A, E>(
      conversationId: string,
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | AgentBusy | AgentError>
    readonly send: (
      conversationId: string,
      message: MessageWithContext,
    ) => Effect.Effect<MessageDelivery, RequestWaiting | AgentError>
    readonly steer: (
      conversation: Conversation,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
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
      const turnLock = yield* Semaphore.make(1)
      const scope = yield* Scope.Scope

      const delivered = Effect.fnUntraced(function* (sent: MessageWithContext) {
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
          ...sent,
          prompt: prompt(sent.message, mentioned, sent.context),
        } satisfies DeliveredMessage
      })

      const deliver = (conversation: Conversation, turnId: string, sent: MessageWithContext) =>
        Effect.gen(function* () {
          const client = yield* conversation.host
          const agentId = conversation.id

          const [, message] = yield* Effect.all([conversation.start(client), delivered(sent)], {
            concurrency: "unbounded",
          })

          yield* turnLock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(agentId)) !== turnId) return

              yield* client.StartTurn({ agentId, turnId, ...message, ...conversation.settings })
            }),
          )
        }).pipe(Effect.catch((error) => failTurn(conversation.id, turnId, hostFailure(error))))

      const failTurn = (conversationId: string, turnId: string, reason: string) =>
        Effect.gen(function* () {
          const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

          yield* transcripts.save(conversationId, [TurnEnded.make({ turnId, ended })])
        }).pipe(
          Effect.catch((cause) => Effect.logWarning("Couldn't fail an undelivered Turn", cause)),
        )

      const deliverTurnsOf = Effect.fnUntraced(function* (claim: ClaimConversation) {
        const started = yield* transcripts.subscribeStarted.pipe(Scope.provide(scope))

        yield* started.pipe(
          Stream.runForEach(({ agentId, turnId, message, images, context }) =>
            claim(agentId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.void,
                  onSome: (conversation) =>
                    deliver(conversation, turnId, { message, images, context }).pipe(
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

          return yield* running.value.Steer({ agentId, ...message }).pipe(
            Effect.as(true),
            Effect.tapError((cause) => Effect.logWarning("Couldn't Steer a Turn", cause)),
            Effect.orElseSucceed(() => false),
          )
        })

      const stop = Effect.fn("ConversationTurns.stop")(function* (conversation: Conversation) {
        const agentId = conversation.id

        yield* turnLock.withPermits(1)(
          Effect.gen(function* () {
            if ((yield* transcripts.runningTurn(agentId)) === null) return

            const running = yield* conversation.runningHost

            const left = Option.isNone(running)
              ? null
              : yield* running.value.StopTurn({ agentId }).pipe(
                  Effect.tapError((cause) => Effect.logWarning("Couldn't stop a Turn", cause)),
                  Effect.orElseSucceed(() => null),
                )

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
            client.AnswerRequest({ agentId: conversation.id, requestId, answer: given }),
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

      const startOrQueue = (conversationId: string, sent: MessageWithContext) =>
        turnLock.withPermits(1)(transcripts.startOrQueue(conversationId, sent))

      return ConversationTurns.of({
        deliverTurnsOf,
        whileIdle: (conversationId, effect) =>
          turnLock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(conversationId)) !== null)
                return yield* new AgentBusy()

              return yield* effect
            }),
          ),
        send: Effect.fn("ConversationTurns.send")(function* (conversationId, sent) {
          yield* refuseWhileWaiting(conversationId)

          return yield* startOrQueue(conversationId, sent)
        }),
        steer: Effect.fn("ConversationTurns.steer")(function* (conversation, sent) {
          yield* refuseWhileWaiting(conversation.id)

          if (!(yield* trySteer(conversation, sent))) yield* startOrQueue(conversation.id, sent)
        }),
        sendQueued: (conversationId, queuedId) =>
          turnLock.withPermits(1)(transcripts.startQueued(conversationId, queuedId)),
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
    }),
  )
}

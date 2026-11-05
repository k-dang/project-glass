import {
  type AgentEngine,
  AgentError,
  isNothingUnsent,
  mentionedToDoIds,
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
import type { ConversationRole, TurnSettings } from "./agentHost/protocol"
import { type HostClient, hostFailure } from "./Placement"
import { prompt } from "./prompt"
import { ToDos } from "./ToDos"
import { encodeImages, StoredMessage, Transcripts } from "./Transcripts"

/** A conversation the backend delivers Turns to: an Agent or the Global conversation. */
export interface Conversation {
  readonly id: string
  readonly engine: AgentEngine
  readonly folder: string
  readonly role: Effect.Effect<ConversationRole, AgentError>
  readonly settings: TurnSettings
  readonly host: Effect.Effect<HostClient, AgentError>
  readonly runningHost: Effect.Effect<Option.Option<HostClient>>
}

/** Finds the conversation a started Turn belongs to, if it is one the caller owns. */
export type FindConversation = (
  conversationId: string,
) => Effect.Effect<Option.Option<Conversation>, AgentError>

const decodeUnsent = Schema.decodeUnknownEffect(Schema.Array(StoredMessage))

const unsentFailure = () =>
  new AgentError({ message: "Couldn't read or save your unsent message. Try again." })

/**
 * What every conversation does with its Turns, its Queued messages, and the user's Unsent
 * message, whatever it is for and wherever its host runs.
 */
export class ConversationTurns extends Context.Service<
  ConversationTurns,
  {
    /** Delivers each Turn that starts in a conversation `find` resolves to its host. */
    readonly deliverTurnsOf: (find: FindConversation) => Effect.Effect<void>
    readonly send: (
      conversationId: string,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly steer: (
      conversation: Conversation,
      message: MessageWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
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
      const lock = yield* Semaphore.make(1)
      const scope = yield* Scope.Scope
      const finders: Array<FindConversation> = []

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

        return { ...sent, prompt: prompt(sent.message, mentioned) } satisfies DeliveredMessage
      })

      const deliver = (conversation: Conversation, turnId: string, sent: MessageWithContext) =>
        Effect.gen(function* () {
          const client = yield* conversation.host
          const { id: agentId, engine, folder } = conversation

          const [, message] = yield* Effect.all(
            [
              conversation.role.pipe(
                Effect.flatMap((role) => client.StartAgent({ agentId, engine, folder, role })),
              ),
              delivered(sent),
            ],
            { concurrency: "unbounded" },
          )

          yield* lock.withPermits(1)(
            Effect.gen(function* () {
              if ((yield* transcripts.runningTurn(agentId)) !== turnId) return

              yield* client.StartTurn({ agentId, turnId, ...message, ...conversation.settings })
            }),
          )
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const reason = hostFailure(error)
              const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

              yield* transcripts.save(conversation.id, [TurnEnded.make({ turnId, ended })])
            }),
          ),
          Effect.catch((cause) => Effect.logWarning("Couldn't fail an undelivered Turn", cause)),
        )

      const findConversation = Effect.fnUntraced(function* (conversationId: string) {
        for (const find of finders) {
          const found = yield* find(conversationId)

          if (Option.isSome(found)) return found
        }

        return Option.none<Conversation>()
      })

      yield* (yield* transcripts.subscribeStarted).pipe(
        Stream.runForEach(({ agentId, turnId, message, images, context }) =>
          findConversation(agentId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.logWarning("A Turn started in no known conversation", agentId),
                onSome: (conversation) =>
                  deliver(conversation, turnId, { message, images, context }).pipe(
                    Effect.forkIn(scope),
                    Effect.asVoid,
                  ),
              }),
            ),
            Effect.catch((cause) => Effect.logWarning("Couldn't deliver a Turn", cause)),
          ),
        ),
        Effect.forkIn(scope),
      )

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

        yield* lock.withPermits(1)(
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

      return ConversationTurns.of({
        deliverTurnsOf: (find) => Effect.sync(() => void finders.push(find)),
        send: Effect.fn("ConversationTurns.send")(function* (conversationId, sent) {
          yield* refuseWhileWaiting(conversationId)
          yield* transcripts.startOrQueue(conversationId, sent)
        }),
        steer: Effect.fn("ConversationTurns.steer")(function* (conversation, sent) {
          yield* refuseWhileWaiting(conversation.id)

          if (!(yield* trySteer(conversation, sent)))
            yield* transcripts.startOrQueue(conversation.id, sent)
        }),
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

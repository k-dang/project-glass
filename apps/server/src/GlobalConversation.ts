import {
  AgentBusy,
  AgentError,
  GlobalConversationProgram,
  type MessageInputWithContext,
  type RequestAnswer,
  type RequestNotWaiting,
  type RequestWaiting,
  type SentMessage,
  type TranscriptUpdate,
  TurnCutOff,
  TurnInterrupted,
} from "@glass/contracts"
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { GlobalRole } from "./agentHost/protocol"
import { type Conversation, ConversationTurns } from "./ConversationTurns"
import { LocalAgentHost } from "./LocalAgentHost"
import { asAgentError } from "./Placement"
import { ServerConfig } from "./ServerConfig"
import { Transcripts } from "./Transcripts"

const StoredConversation = Schema.Struct({ id: Schema.String, ...GlobalConversationProgram.fields })

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredConversation))

const firstProgram = new GlobalConversationProgram({
  engine: "claude-code",
  model: null,
  effort: null,
})

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save the Global conversation. Try again." })

export class GlobalConversation extends Context.Service<
  GlobalConversation,
  {
    readonly program: Effect.Effect<GlobalConversationProgram>
    readonly changeProgram: (
      program: GlobalConversationProgram,
    ) => Effect.Effect<GlobalConversationProgram, AgentBusy | AgentError>
    readonly transcript: Stream.Stream<TranscriptUpdate, AgentError>
    readonly send: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly steer: (
      input: MessageInputWithContext,
    ) => Effect.Effect<void, RequestWaiting | AgentError>
    readonly cancelQueued: (queuedId: string) => Effect.Effect<void, AgentError>
    readonly sendQueued: (queuedId: string) => Effect.Effect<void, AgentBusy | AgentError>
    readonly stop: Effect.Effect<void, AgentError>
    readonly answer: (
      requestId: string,
      answer: RequestAnswer,
    ) => Effect.Effect<void, RequestNotWaiting | AgentError>
    readonly unsent: Effect.Effect<SentMessage, AgentError>
    readonly saveUnsent: (unsent: SentMessage) => Effect.Effect<void, AgentError>
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
      const scope = yield* Scope.Scope
      const folder = join(config.dataDirectory, "global-conversation")

      const [stored] = yield* sql`
        SELECT id, engine, model, effort FROM global_conversation LIMIT 1
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const id = stored?.id ?? randomUUID()

      if (stored === undefined)
        yield* sql`INSERT INTO global_conversation ${sql.insert({
          id,
          engine: firstProgram.engine,
          model: firstProgram.model,
          effort: firstProgram.effort,
        })}`.pipe(Effect.orDie)

      const program = yield* SubscriptionRef.make(
        stored === undefined ? firstProgram : new GlobalConversationProgram(stored),
      )

      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.orDie)

      yield* (yield* host.subscribeStopped).pipe(
        Stream.runForEach(() =>
          transcripts
            .endRunning(TurnCutOff.make({}), [id])
            .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off a Turn", cause))),
        ),
        Effect.forkIn(scope),
      )

      const conversation = SubscriptionRef.get(program).pipe(
        Effect.map(({ engine, model, effort }): Conversation => ({
          id,
          engine,
          folder,
          role: Effect.succeed(GlobalRole.make({})),
          settings: { model, effort, permissionMode: null },
          host: host.client,
          runningHost: host.running,
        })),
      )

      yield* turns.deliverTurnsOf((conversationId) =>
        conversationId === id ? conversation.pipe(Effect.map(Option.some)) : Effect.succeedNone,
      )

      yield* transcripts.endRunning(TurnInterrupted.make({}), [id]).pipe(Effect.orDie)

      const saveProgram = (next: GlobalConversationProgram) =>
        sql`
          UPDATE global_conversation
          SET engine = ${next.engine}, model = ${next.model}, effort = ${next.effort}
          WHERE id = ${id}
        `.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Couldn't save the Global conversation's program", cause),
          ),
          Effect.mapError(storageFailure),
          Effect.andThen(SubscriptionRef.set(program, next)),
          Effect.as(next),
        )

      const switchProgram = (next: GlobalConversationProgram) =>
        turns.whileIdle(
          id,
          host.running.pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (running) =>
                  running.StopAgent({ agentId: id }).pipe(Effect.mapError(asAgentError)),
              }),
            ),
            Effect.andThen(saveProgram(next)),
          ),
        )

      const changeProgram = Effect.fn("GlobalConversation.changeProgram")(function* (
        next: GlobalConversationProgram,
      ) {
        const current = yield* SubscriptionRef.get(program)

        return yield* next.engine === current.engine ? saveProgram(next) : switchProgram(next)
      })

      return GlobalConversation.of({
        program: SubscriptionRef.get(program),
        changeProgram,
        transcript: transcripts.watch(id),
        send: (input) => turns.send(id, input),
        steer: (input) =>
          conversation.pipe(Effect.flatMap((current) => turns.steer(current, input))),
        cancelQueued: (queuedId) => transcripts.cancelQueued(id, queuedId),
        sendQueued: (queuedId) => turns.sendQueued(id, queuedId),
        stop: conversation.pipe(Effect.flatMap(turns.stop)),
        answer: (requestId, answer) =>
          conversation.pipe(Effect.flatMap((current) => turns.answer(current, requestId, answer))),
        unsent: turns.unsent(id),
        saveUnsent: (unsent) => turns.saveUnsent(id, unsent),
      })
    }),
  )
}

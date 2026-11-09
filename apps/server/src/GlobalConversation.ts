import {
  type AgentBusy,
  AgentError,
  type MessageInputWithContext,
  ModelChoice,
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
import { Transcripts } from "./Transcripts"

const StoredConversation = Schema.Struct({ id: Schema.String, ...ModelChoice.fields })

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredConversation))

const hostGone = new AgentError({ message: "Glass lost the process that runs Agents. Try again." })

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save the Global conversation. Try again." })

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
      const credentials = yield* McpCredentials
      const scope = yield* Scope.Scope
      const folder = join(config.dataDirectory, "global-conversation")

      const [stored] = yield* sql`
        SELECT id, model, effort FROM global_conversation LIMIT 1
      `.pipe(Effect.flatMap(decodeStored), Effect.orDie)

      const id = stored?.id ?? randomUUID()

      if (stored === undefined)
        yield* sql`INSERT INTO global_conversation ${sql.insert({
          id,
          model: null,
          effort: null,
        })}`.pipe(Effect.orDie)

      const model = yield* SubscriptionRef.make<ModelChoice>({
        model: stored?.model ?? null,
        effort: stored?.effort ?? null,
      })

      yield* fs.makeDirectory(folder, { recursive: true }).pipe(Effect.orDie)

      // Each start of pi gets a fresh credential, revoked when it is replaced, and with the host's
      // lifetime when the host stops.
      const starting = yield* Semaphore.make(1)
      let runningCredential: Scope.Closeable | null = null

      const replaceRunning = (next: Scope.Closeable) =>
        Effect.suspend(() => {
          const ending = runningCredential
          runningCredential = next

          return ending === null ? Effect.void : Scope.close(ending, Exit.void)
        })

      const start = (client: HostClient) =>
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
                  .issue({ conversationId: id })
                  .pipe(Scope.provide(credential)),
              },
            })

            const started = yield* client
              .StartAgent({ agentId: id, engine: "pi", folder, role, skills: [] })
              .pipe(Effect.onError(() => revoke))

            yield* started ? replaceRunning(credential) : revoke
          }),
        )

      yield* (yield* host.subscribeStopped).pipe(
        Stream.runForEach(() =>
          transcripts
            .endRunning(TurnCutOff.make({}), [id])
            .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't cut off a Turn", cause))),
        ),
        Effect.forkIn(scope),
      )

      const conversation = SubscriptionRef.get(model).pipe(
        Effect.map((choice): Conversation => ({
          id,
          start,
          settings: { ...choice, permissionMode: null },
          host: host.client,
          runningHost: host.running,
        })),
      )

      yield* turns.deliverTurnsOf((conversationId) =>
        conversationId === id ? conversation.pipe(Effect.map(Option.some)) : Effect.succeedNone,
      )

      yield* transcripts.endRunning(TurnInterrupted.make({}), [id]).pipe(Effect.orDie)

      const changeModel = Effect.fn("GlobalConversation.changeModel")(function* (
        choice: ModelChoice,
      ) {
        yield* sql`
          UPDATE global_conversation
          SET model = ${choice.model}, effort = ${choice.effort}
          WHERE id = ${id}
        `.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Couldn't save the Global conversation's model", cause),
          ),
          Effect.mapError(storageFailure),
        )
        yield* SubscriptionRef.set(model, choice)
      })

      return GlobalConversation.of({
        model: SubscriptionRef.get(model),
        changeModel,
        transcript: transcripts.watch(id),
        send: (input) => turns.send(id, input).pipe(Effect.asVoid),
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

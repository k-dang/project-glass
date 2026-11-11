import {
  Agent,
  AgentError,
  type AgentEvent,
  CapturedContext,
  endTurnEvents,
  FeedbackNote,
  isRequestPart,
  Image,
  type MessageDelivery,
  type MessageWithContext,
  PartAppended,
  AgentBusy,
  QueuedMessagesChanged,
  QueuedMessage,
  QueuedMessageStarted,
  requestPartTags,
  SentMessage,
  StatusChanged,
  TranscriptSnapshot,
  type Transcript,
  type TranscriptUpdate,
  Turn,
  TurnEnd,
  type TurnEnded,
  type TurnEnding,
  TurnPart,
  TurnStarted,
} from "@glass/contracts"
import {
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Predicate,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import {
  type ConversationEvent,
  type ConversationState,
  type ConversationWrite,
  stepConversation,
} from "./conversationState"
import { recordUnit } from "./wideEvents"

const encodePart = Schema.encodeSync(Schema.fromJsonString(TurnPart))

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

export const ImagesJson = Schema.fromJsonString(Schema.Array(Image))

export const encodeImages = Schema.encodeSync(ImagesJson)

const ContextJson = Schema.NullOr(Schema.fromJsonString(CapturedContext))

const encodeContext = Schema.encodeSync(ContextJson)

const FeedbackJson = Schema.fromJsonString(Schema.Array(FeedbackNote))

const encodeFeedback = Schema.encodeSync(FeedbackJson)

const decodeTurns = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Turn.fields.id,
      message: Turn.fields.message,
      images: ImagesJson,
      context: ContextJson,
      feedback: FeedbackJson,
      sentAt: Turn.fields.sentAt,
      ended: Schema.NullOr(Schema.fromJsonString(TurnEnd)),
    }),
  ),
)

const decodeParts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ turnId: Schema.String, part: Schema.fromJsonString(TurnPart) })),
)

const decodeRunning = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      agentId: Schema.String,
      turnId: Schema.String,
      part: Schema.NullOr(Schema.fromJsonString(TurnPart)),
    }),
  ),
)

const decodeExists = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ found: Schema.Int })))

export const StoredMessage = Schema.Struct({ ...SentMessage.fields, images: ImagesJson })

const decodeQueued = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...QueuedMessage.fields,
      ...StoredMessage.fields,
      context: ContextJson,
      feedback: FeedbackJson,
    }),
  ),
)

const decodeEndedTurn = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      sentAt: Turn.fields.sentAt,
      engine: Schema.NullOr(Agent.fields.engine),
      model: Schema.NullOr(Agent.fields.model),
      effort: Schema.NullOr(Agent.fields.effort),
      sandboxProvider: Schema.NullOr(Schema.String),
      toolCalls: Schema.Int,
      failedToolCalls: Schema.Int,
    }),
  ),
)

const decodeTurnIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

const decodePositions = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ first: Schema.NullOr(Schema.Int), last: Schema.NullOr(Schema.Int) }),
  ),
)

interface Published {
  readonly agentId: string
  readonly update: TranscriptUpdate
}

export type StartedTurn = typeof TurnStarted.Type & { readonly agentId: string }

const joinConsecutiveAppends = (events: ReadonlyArray<AgentEvent>) => {
  const joined: Array<AgentEvent> = []

  for (const event of events) {
    const previous = joined.at(-1)

    if (
      Predicate.isTagged(event, "PartAppended") &&
      Predicate.isTagged(previous, "PartAppended") &&
      previous.turnId === event.turnId &&
      previous.index === event.index
    )
      joined[joined.length - 1] = PartAppended.make({
        ...previous,
        text: previous.text + event.text,
      })
    else joined.push(event)
  }

  return joined
}

const changesRequest = (update: TranscriptUpdate) =>
  Predicate.isTagged(update, "PartSet") && isRequestPart(update.part)

class TurnFailure extends Data.TaggedError("TurnFailure")<{ readonly message: string }> {}

const turnExit = (ending: TurnEnding): Exit.Exit<void, TurnFailure> =>
  Predicate.isTagged(ending, "Done")
    ? Exit.void
    : Predicate.isTagged(ending, "Failed")
      ? Exit.fail(new TurnFailure({ message: ending.reason }))
      : Exit.interrupt()

type StorageError = SqlError.SqlError | Schema.SchemaError

const isStorageError = <E>(cause: E): cause is Extract<E, StorageError> =>
  Predicate.isTagged(cause, "SqlError") || Predicate.isTagged(cause, "SchemaError")

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save the Agent's transcript. Try again." })

export class Transcripts extends Context.Service<
  Transcripts,
  {
    readonly save: (
      agentId: string,
      events: ReadonlyArray<AgentEvent>,
      throughJournalEntry?: number,
    ) => Effect.Effect<void, AgentError>
    readonly watch: (agentId: string) => Stream.Stream<TranscriptUpdate, AgentError>
    readonly read: (agentId: string) => Effect.Effect<Transcript, AgentError>
    readonly endRunning: (
      ending: TurnEnding,
      agentIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, AgentError>
    readonly runningTurn: (agentId: string) => Effect.Effect<string | null, AgentError>
    readonly startOrQueue: (
      agentId: string,
      input: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, AgentError>,
    ) => Effect.Effect<MessageDelivery, AgentError>
    readonly prependQueued: (
      agentId: string,
      inputs: ReadonlyArray<MessageWithContext>,
    ) => Effect.Effect<void, AgentError>
    readonly cancelQueued: (
      agentId: string,
      queuedId: string,
      restore?: (feedback: ReadonlyArray<FeedbackNote>) => Effect.Effect<void, AgentError>,
    ) => Effect.Effect<void, QueuedMessageStarted | AgentError>
    readonly startQueued: (
      agentId: string,
      queuedId: string,
    ) => Effect.Effect<void, AgentBusy | AgentError>
    readonly subscribeStarted: Effect.Effect<Stream.Stream<StartedTurn>, never, Scope.Scope>
    readonly waiting: Stream.Stream<ReadonlySet<string>>
    readonly isWaiting: (agentId: string) => Effect.Effect<boolean>
    readonly setStatus: (agentId: string, status: string | null) => Effect.Effect<void>
    readonly remove: (agentId: string) => Effect.Effect<void, AgentError>
  }
>()("@glass/server/Transcripts") {
  static readonly layer = Layer.effect(
    Transcripts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const published = yield* PubSub.unbounded<Published>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const statuses = new Map<string, string>()
      const waitingAgents = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())

      const hasWaitingRequest = (agentId: string) =>
        sql`
          SELECT EXISTS (
            SELECT 1 FROM agent_turn_part p JOIN agent_turn t ON t.id = p.turn_id
            WHERE t.agent_id = ${agentId}
              AND json_extract(p.part, '$._tag') IN ${sql.in(requestPartTags)}
              AND json_extract(p.part, '$.status') = 'waiting'
          ) AS found
        `.pipe(
          Effect.flatMap(decodeExists),
          Effect.map(([row]) => row?.found === 1),
        )

      const markWaiting = (agentId: string, waits: boolean) =>
        SubscriptionRef.update(waitingAgents, (current) => {
          if (current.has(agentId) === waits) return current
          const next = new Set(current)

          if (waits) next.add(agentId)
          else next.delete(agentId)

          return next
        })

      const lockFor = (agentId: string) => {
        const lock = locks.get(agentId) ?? Semaphore.makeUnsafe(1)
        locks.set(agentId, lock)

        return lock
      }

      const writeApplied = (agentId: string, event: AgentEvent) =>
        Match.value(event).pipe(
          Match.tagsExhaustive({
            TurnStarted: ({ turnId, message, images, context, feedback, sentAt }) =>
              sql`INSERT INTO agent_turn ${sql.insert({
                id: turnId,
                agent_id: agentId,
                message,
                images: encodeImages(images),
                context: encodeContext(context),
                feedback: encodeFeedback(feedback),
                sent_at: DateTime.formatIso(sentAt),
              })}`.pipe(Effect.as(true)),
            PartSet: ({ turnId, index, part }) =>
              sql`
                INSERT INTO agent_turn_part ${sql.insert({ turn_id: turnId, position: index, part: encodePart(part) })}
                ON CONFLICT (turn_id, position) DO UPDATE SET part = excluded.part
              `.pipe(Effect.as(true)),
            PartAppended: ({ turnId, index, text }) =>
              sql`
                UPDATE agent_turn_part
                SET part = json_set(part, '$.text', json_extract(part, '$.text') || ${text})
                WHERE turn_id = ${turnId} AND position = ${index}
              `.pipe(Effect.as(true)),
            TurnEnded: ({ turnId, ended }) =>
              sql`
                UPDATE agent_turn SET ended = ${encodeEnd(ended)}
                WHERE id = ${turnId}
                  AND (ended IS NULL OR json_extract(ended, '$.ending._tag') = 'CutOff')
                RETURNING id
              `.pipe(Effect.map((rows) => rows.length > 0)),
          }),
        )

      const runningTurn = (agentId: string) =>
        sql`SELECT id FROM agent_turn WHERE agent_id = ${agentId} AND ended IS NULL`.pipe(
          Effect.flatMap(decodeTurnIds),
          Effect.map(([turn]) => turn?.id ?? null),
        )

      const queued = (agentId: string) =>
        sql`
          SELECT id, message, images, context, feedback FROM agent_queued_message
          WHERE agent_id = ${agentId} ORDER BY position
        `.pipe(Effect.flatMap(decodeQueued))

      const queuedChanged = (agentId: string) =>
        queued(agentId).pipe(
          Effect.map((current) => QueuedMessagesChanged.make({ queued: current })),
        )

      const insertQueued = (agentId: string, position: number, input: QueuedMessage) =>
        sql`INSERT INTO agent_queued_message ${sql.insert({
          id: input.id,
          agent_id: agentId,
          position,
          message: input.message,
          images: encodeImages(input.images),
          context: encodeContext(input.context),
          feedback: encodeFeedback(input.feedback),
        })}`

      const queuedPositions = (agentId: string) =>
        sql`
          SELECT MIN(position) AS first, MAX(position) AS last
          FROM agent_queued_message WHERE agent_id = ${agentId}
        `.pipe(
          Effect.flatMap(decodePositions),
          Effect.map(([found]) => ({ first: found?.first ?? 0, last: found?.last ?? 0 })),
        )

      const execute = Effect.fnUntraced(function* (
        agentId: string,
        writes: ReadonlyArray<ConversationWrite>,
      ) {
        const started: Array<TranscriptUpdate> = []

        for (const write of writes)
          switch (write.type) {
            case "startTurn": {
              const event = TurnStarted.make({
                turnId: write.message.id,
                message: write.message.message,
                images: write.message.images,
                context: write.message.context,
                feedback: write.message.feedback,
                sentAt: yield* DateTime.now,
              })

              yield* writeApplied(agentId, event)
              started.push(event)
              break
            }

            case "enqueue":
              yield* insertQueued(
                agentId,
                (yield* queuedPositions(agentId)).last + 1,
                write.message,
              )
              break
            case "prepend": {
              const start = (yield* queuedPositions(agentId)).first - write.messages.length

              yield* Effect.forEach(
                write.messages,
                (message, index) => insertQueued(agentId, start + index, message),
                { discard: true },
              )
              break
            }

            case "dequeue":
              yield* sql`DELETE FROM agent_queued_message WHERE id = ${write.queuedId}`
              break
          }

        return writes.some(({ type }) => type !== "startTurn")
          ? [yield* queuedChanged(agentId), ...started]
          : started
      })

      const conversation = Effect.fnUntraced(function* (agentId: string) {
        return {
          running: yield* runningTurn(agentId),
          queued: yield* queued(agentId),
        } satisfies ConversationState
      })

      const step = Effect.fnUntraced(function* (agentId: string, event: ConversationEvent) {
        const { outcome, writes } = stepConversation(yield* conversation(agentId), event)

        return { outcome, updates: yield* execute(agentId, writes) }
      })

      const changeWith = <A, E, R>(
        agentId: string,
        effect: Effect.Effect<readonly [A, ReadonlyArray<TranscriptUpdate>], E, R>,
      ) =>
        lockFor(agentId).withPermits(1)(
          Effect.gen(function* () {
            const [decided, updates] = yield* sql.withTransaction(effect)

            if (updates.some(changesRequest))
              yield* markWaiting(agentId, yield* hasWaitingRequest(agentId))

            yield* PubSub.publishAll(
              published,
              updates.map((update) => ({ agentId, update })),
            )

            return decided
          }),
        )

      const change = <E, R>(
        agentId: string,
        effect: Effect.Effect<ReadonlyArray<TranscriptUpdate>, E, R>,
      ) =>
        changeWith(
          agentId,
          Effect.map(effect, (updates) => [undefined, updates] as const),
        )

      const recordTurn = Effect.fnUntraced(function* (
        agentId: string,
        { turnId, ended: { at, ending } }: typeof TurnEnded.Type,
      ) {
        const [turn] = yield* sql`
          SELECT
            t.sent_at AS sentAt, a.engine, a.model, a.effort, a.sandbox_provider AS sandboxProvider,
            COUNT(p.turn_id) AS toolCalls,
            COUNT(CASE json_extract(p.part, '$.status') WHEN 'failed' THEN 1 END) AS failedToolCalls
          FROM agent_turn t
          LEFT JOIN agent a ON a.id = t.agent_id
          LEFT JOIN agent_turn_part p
            ON p.turn_id = t.id AND json_extract(p.part, '$._tag') = 'ToolCall'
          WHERE t.id = ${turnId}
          GROUP BY t.id
        `.pipe(Effect.flatMap(decodeEndedTurn))

        if (turn === undefined) return

        yield* recordUnit("Turn", {
          startedAt: turn.sentAt,
          endedAt: at,
          exit: turnExit(ending),
          fields: {
            agent_id: agentId,
            turn_id: turnId,
            ending: ending._tag,
            engine: turn.engine,
            model: turn.model,
            effort: turn.effort,
            sandbox_provider: turn.sandboxProvider,
            tool_calls: turn.toolCalls,
            failed_tool_calls: turn.failedToolCalls,
          },
        })
      })

      const save = (
        agentId: string,
        events: ReadonlyArray<AgentEvent>,
        throughJournalEntry?: number,
      ) =>
        changeWith(
          agentId,
          Effect.gen(function* () {
            if (throughJournalEntry !== undefined)
              yield* sql`UPDATE agent SET journal_saved = ${throughJournalEntry} WHERE id = ${agentId}`

            const written = yield* Effect.filter(joinConsecutiveAppends(events), (event) =>
              writeApplied(agentId, event),
            )

            const ended = written.filter((event) => Predicate.isTagged(event, "TurnEnded"))

            const next = yield* Effect.forEach(ended, ({ ended: { ending } }) =>
              step(agentId, { type: "turnEnded", ending }),
            )

            return [ended, [...written, ...next.flatMap(({ updates }) => updates)]] as const
          }),
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a transcript", cause)),
          Effect.mapError(storageFailure),
          Effect.flatMap((ended) =>
            Effect.forEach(ended, (event) => recordTurn(agentId, event), { discard: true }).pipe(
              Effect.catch((cause) => Effect.logWarning("Couldn't describe an ended Turn", cause)),
            ),
          ),
        )

      const snapshot = Effect.fnUntraced(function* (agentId: string) {
        const turns = yield* decodeTurns(
          yield* sql`
            SELECT id, message, images, context, feedback, sent_at AS sentAt, ended
            FROM agent_turn WHERE agent_id = ${agentId} ORDER BY rowid
          `,
        )

        const parts = yield* decodeParts(
          yield* sql`
            SELECT turn_id AS turnId, part FROM agent_turn_part
            WHERE turn_id IN (SELECT id FROM agent_turn WHERE agent_id = ${agentId})
            ORDER BY turn_id, position
          `,
        )

        const byTurn = Map.groupBy(parts, ({ turnId }) => turnId)

        return TranscriptSnapshot.make({
          turns: turns.map((turn) => ({
            ...turn,
            parts: (byTurn.get(turn.id) ?? []).map(({ part }) => part),
          })),
          queued: yield* queued(agentId),
          status: statuses.get(agentId) ?? null,
        })
      })

      const endRunning = Effect.fn("Transcripts.endRunning")(function* (
        ending: TurnEnding,
        agentIds: ReadonlyArray<string>,
      ) {
        if (agentIds.length === 0) return

        const running = yield* sql`
          SELECT t.agent_id AS agentId, t.id AS turnId, p.part AS part
          FROM agent_turn t LEFT JOIN agent_turn_part p ON p.turn_id = t.id
          WHERE t.ended IS NULL AND ${sql.in("t.agent_id", agentIds)}
          ORDER BY t.rowid, p.position
        `.pipe(Effect.flatMap(decodeRunning), Effect.mapError(storageFailure))

        const ended = { at: yield* DateTime.now, ending }

        for (const [runningAgent, rows] of Map.groupBy(running, (row) => row.agentId)) {
          const events = Array.from(
            Map.groupBy(rows, ({ turnId }) => turnId),
            ([turnId, found]) =>
              endTurnEvents(
                turnId,
                found.flatMap(({ part }) => (part === null ? [] : [part])),
                ended,
              ),
          )

          yield* save(runningAgent, events.flat())
        }
      })

      const withStorageFailure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.catchIf(effect, isStorageError, (cause) =>
          Effect.logWarning(`Couldn't ${name}`, cause).pipe(Effect.andThen(storageFailure())),
        )

      return Transcripts.of({
        save,
        endRunning,
        watch: (agentId) =>
          Stream.unwrap(
            lockFor(agentId).withPermits(1)(
              Effect.gen(function* () {
                const live = yield* PubSub.subscribe(published)
                const first = yield* snapshot(agentId)

                return Stream.succeed<TranscriptUpdate>(first).pipe(
                  Stream.concat(
                    Stream.fromSubscription(live).pipe(
                      Stream.filter((entry) => entry.agentId === agentId),
                      Stream.map(({ update }) => update),
                    ),
                  ),
                )
              }),
            ),
          ).pipe(
            Stream.tapError((cause) => Effect.logWarning("Couldn't read a transcript", cause)),
            Stream.mapError(storageFailure),
          ),
        read: (agentId) =>
          withStorageFailure(
            "read a transcript",
            lockFor(agentId).withPermits(1)(snapshot(agentId)),
          ),
        runningTurn: (agentId) => withStorageFailure("read a running Turn", runningTurn(agentId)),
        startOrQueue: (agentId, sent, feedback = Effect.succeed([])) =>
          withStorageFailure(
            "send a message",
            changeWith(
              agentId,
              Effect.gen(function* () {
                const message = { ...sent, feedback: yield* feedback, id: randomUUID() }
                const { outcome, updates } = yield* step(agentId, { type: "send", message })

                return [outcome.type === "started" ? "started" : "queued", updates] as const
              }),
            ),
          ),
        prependQueued: (agentId, inputs) =>
          withStorageFailure(
            "put messages back in front of the Queued ones",
            change(
              agentId,
              execute(agentId, [
                {
                  type: "prepend",
                  messages: inputs.map((input) => ({ ...input, feedback: [], id: randomUUID() })),
                },
              ]),
            ),
          ),
        cancelQueued: (agentId, queuedId, restore = () => Effect.void) =>
          withStorageFailure(
            "cancel a Queued message",
            change(
              agentId,
              Effect.gen(function* () {
                const { outcome, updates } = yield* step(agentId, {
                  type: "cancelQueued",
                  queuedId,
                })

                if (outcome.type === "canceled") {
                  yield* restore(outcome.feedback)

                  return updates
                }

                const [started] = yield* sql`
                  SELECT id FROM agent_turn WHERE id = ${queuedId} AND agent_id = ${agentId}
                `.pipe(Effect.flatMap(decodeTurnIds))

                return started === undefined ? [] : yield* new QueuedMessageStarted()
              }),
            ),
          ),
        startQueued: (agentId, queuedId) =>
          withStorageFailure(
            "start a Queued message",
            change(
              agentId,
              Effect.flatMap(
                step(agentId, { type: "sendQueued", queuedId }),
                ({ outcome, updates }) =>
                  outcome.type === "busy" ? Effect.fail(new AgentBusy()) : Effect.succeed(updates),
              ),
            ),
          ),
        subscribeStarted: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.flatMap(({ agentId, update }) =>
                Predicate.isTagged(update, "TurnStarted")
                  ? Stream.succeed({ ...update, agentId })
                  : Stream.empty,
              ),
            ),
          ),
        ),
        waiting: SubscriptionRef.changes(waitingAgents),
        isWaiting: (agentId) =>
          SubscriptionRef.get(waitingAgents).pipe(Effect.map((current) => current.has(agentId))),
        setStatus: (agentId, status) =>
          lockFor(agentId).withPermits(1)(
            Effect.suspend(() => {
              if (status === null) statuses.delete(agentId)
              else statuses.set(agentId, status)

              return PubSub.publish(published, {
                agentId,
                update: StatusChanged.make({ status }),
              })
            }),
          ),
        remove: Effect.fn("Transcripts.remove")(function* (agentId: string) {
          yield* lockFor(agentId).withPermits(1)(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM agent_turn_part
                WHERE turn_id IN (SELECT id FROM agent_turn WHERE agent_id = ${agentId})
              `
              yield* sql`DELETE FROM agent_turn WHERE agent_id = ${agentId}`
              yield* sql`DELETE FROM agent_queued_message WHERE agent_id = ${agentId}`
            }).pipe(sql.withTransaction),
          )
          locks.delete(agentId)
          statuses.delete(agentId)
          yield* markWaiting(agentId, false)
        }, Effect.mapError(storageFailure)),
      })
    }),
  )
}

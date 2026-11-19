import {
  Conversation,
  ConversationError,
  type AgentEvent,
  endTurnEvents,
  AgentStatusesChanged,
  FeedbackNote,
  isRequestPart,
  isWaiting,
  Image,
  type MessageDelivery,
  PartAppended,
  ConversationBusy,
  QueuedMessagesChanged,
  QueuedMessage,
  QueuedMessageStarted,
  type RequestPart,
  requestPartTags,
  SentMessage,
  StatusChanged,
  TranscriptSnapshot,
  type Transcript,
  type TranscriptUpdate,
  Turn,
  TurnEnd,
  TurnEnded,
  type TurnEnding,
  TurnContext,
  CapturedContext,
  EarlierTurns,
  type MessageWithContext,
  TurnPart,
  TurnStarted,
  type GlobalConversationUpdate,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  Data,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  PubSub,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"
import { randomUUID } from "node:crypto"
import {
  type ConversationEvent,
  type ConversationState,
  type ConversationWrite,
  stepConversation,
} from "./conversationState"
import type { HostEvent } from "./agentHost/protocol"
import type { SavedThrough } from "./hostJournal"
import { recordUnit } from "./wideEvents"

const encodePart = Schema.encodeSync(Schema.fromJsonString(TurnPart))

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

export const ImagesJson = Schema.fromJsonString(Schema.Array(Image))

export const encodeImages = Schema.encodeSync(ImagesJson)

const ContextJson = Schema.NullOr(Schema.fromJsonString(TurnContext))

const encodeContext = Schema.encodeSync(ContextJson)

const FeedbackJson = Schema.fromJsonString(Schema.Array(FeedbackNote))

const encodeFeedback = Schema.encodeSync(FeedbackJson)

const TurnRow = Schema.Struct({
  id: Turn.fields.id,
  message: Turn.fields.message,
  images: ImagesJson,
  context: ContextJson,
  feedback: FeedbackJson,
  sentAt: Turn.fields.sentAt,
  ended: Schema.NullOr(Schema.fromJsonString(TurnEnd)),
})

const decodeTurns = Schema.decodeUnknownEffect(Schema.Array(TurnRow))

const decodePagedTurns = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ...TurnRow.fields, position: Schema.Int })),
)

const decodeParts = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ turnId: Schema.String, part: Schema.fromJsonString(TurnPart) })),
)

const decodeRunning = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      conversationId: Schema.String,
      turnId: Schema.String,
      part: Schema.NullOr(Schema.fromJsonString(TurnPart)),
    }),
  ),
)

const decodeWaiting = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      conversationId: Schema.String,
      sentAt: Turn.fields.sentAt,
      part: Schema.fromJsonString(TurnPart),
    }),
  ),
)

const decodeEnds = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ conversationId: Schema.String, ended: Schema.fromJsonString(TurnEnd) }),
  ),
)

export const StoredMessage = Schema.Struct({ ...SentMessage.fields, images: ImagesJson })

const decodeQueued = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...QueuedMessage.fields,
      ...StoredMessage.fields,
      context: Schema.NullOr(Schema.fromJsonString(CapturedContext)),
      feedback: FeedbackJson,
    }),
  ),
)

const decodeEndedTurn = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      sentAt: Turn.fields.sentAt,
      harness: Schema.NullOr(Conversation.fields.harness),
      model: Schema.NullOr(Conversation.fields.model),
      effort: Schema.NullOr(Conversation.fields.effort),
      sandboxProvider: Schema.NullOr(Schema.String),
      toolCalls: Schema.Int,
      failedToolCalls: Schema.Int,
    }),
  ),
)

const decodeCount = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ count: Schema.Int })))

const decodeTurnIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: Schema.String })))

const decodeMessages = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ message: Schema.String })),
)

const decodePositions = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ first: Schema.NullOr(Schema.Int), last: Schema.NullOr(Schema.Int) }),
  ),
)

export const RECENT_TURNS = 20

interface Published {
  readonly conversationId: string
  readonly update: TranscriptUpdate
  readonly reported?: boolean
}

export interface WaitingRequest {
  readonly part: RequestPart
  readonly since: DateTime.Utc
}

export type WaitingByConversation = ReadonlyMap<string, Arr.NonEmptyReadonlyArray<WaitingRequest>>

export type UnseenByConversation = ReadonlyMap<string, TurnEnd>

export type StartedTurn = typeof TurnStarted.Type & { readonly conversationId: string }

const joinConsecutiveAppends = (events: ReadonlyArray<SavedEvent>) => {
  const joined: Array<SavedEvent> = []

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

const sameEnd = Schema.toEquivalence(TurnEnd)

const startsOrEndsTurn = (update: TranscriptUpdate) =>
  Predicate.isTagged(update, "TurnStarted") || Predicate.isTagged(update, "TurnEnded")

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
  new ConversationError({
    message: "Couldn't read or save the Conversation's transcript. Try again.",
  })

const queuedAgain = (inputs: ReadonlyArray<MessageWithContext>): ReadonlyArray<QueuedMessage> =>
  inputs.map((input) => ({ ...input, feedback: [], id: randomUUID() }))

type SavedEvent = Exclude<HostEvent, AgentStatusesChanged>

export class Transcripts extends Context.Service<
  Transcripts,
  {
    readonly save: (
      conversationId: string,
      events: ReadonlyArray<HostEvent>,
      journal?: SavedThrough,
    ) => Effect.Effect<void, ConversationError>
    readonly watch: (conversationId: string) => Stream.Stream<TranscriptUpdate, ConversationError>
    readonly read: (
      conversationId: string,
      turns?: number,
    ) => Effect.Effect<Transcript, ConversationError>
    /** Publishes the Turns before `before` to the conversation's watchers, in order with its events. */
    readonly loadEarlier: (
      conversationId: string,
      before: string,
    ) => Effect.Effect<void, ConversationError>
    readonly endRunning: (
      ending: TurnEnding,
      conversationIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, ConversationError>
    readonly endTurn: (
      ending: TurnEnding,
      conversationId: string,
      turnId: string,
    ) => Effect.Effect<void, ConversationError>
    readonly askedToStop: (turnId: string) => Effect.Effect<void>
    readonly runningTurn: (
      conversationId: string,
    ) => Effect.Effect<string | null, ConversationError>
    readonly idle: (conversationId: string) => Effect.Effect<boolean, ConversationError>
    /** Records the covered outcomes in the Turn's transaction, before publishing TurnStarted. */
    readonly startGlobalConversationUpdate: (
      conversationId: string,
      globalConversationUpdate: GlobalConversationUpdate,
      record: (turnId: string) => Effect.Effect<void, ConversationError>,
    ) => Effect.Effect<void, ConversationError>
    readonly recoverGlobalConversationUpdates: (
      conversationIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<StartedTurn>, ConversationError>
    readonly runningMessage: (
      conversationId: string,
    ) => Effect.Effect<string | null, ConversationError>
    readonly startOrQueue: (
      conversationId: string,
      input: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ConversationError>,
    ) => Effect.Effect<MessageDelivery, ConversationError>
    readonly prependQueued: (
      conversationId: string,
      inputs: ReadonlyArray<MessageWithContext>,
    ) => Effect.Effect<void, ConversationError>
    readonly cancelQueued: (
      conversationId: string,
      queuedId: string,
      restore?: (feedback: ReadonlyArray<FeedbackNote>) => Effect.Effect<void, ConversationError>,
    ) => Effect.Effect<void, QueuedMessageStarted | ConversationError>
    readonly startQueued: (
      conversationId: string,
      queuedId: string,
    ) => Effect.Effect<void, ConversationBusy | ConversationError>
    readonly subscribeStarted: Effect.Effect<Stream.Stream<StartedTurn>, never, Scope.Scope>
    readonly subscribeEnded: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>
    readonly lastEnds: (
      conversationIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, TurnEnd>, ConversationError>
    readonly waiting: Stream.Stream<WaitingByConversation>
    readonly waitingNow: Effect.Effect<WaitingByConversation>
    readonly isWaiting: (conversationId: string) => Effect.Effect<boolean>
    readonly unseen: Stream.Stream<UnseenByConversation>
    readonly running: Stream.Stream<ReadonlySet<string>>
    readonly markSeen: (
      conversationId: string,
      endedAt: DateTime.Utc,
    ) => Effect.Effect<void, ConversationError>
    readonly setStatus: (conversationId: string, status: string | null) => Effect.Effect<void>
    readonly remove: (conversationId: string) => Effect.Effect<void, ConversationError>
  }
>()("@glass/server/Transcripts") {
  static readonly layer = Layer.effect(
    Transcripts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const published = yield* PubSub.unbounded<Published>()
      const locks = new Map<string, Semaphore.Semaphore>()
      const statuses = new Map<string, string>()
      const agentStatuses = new Map<string, AgentStatusesChanged>()

      const setAgentStatuses = (conversationId: string, shown: AgentStatusesChanged) =>
        lockFor(conversationId).withPermits(1)(
          Effect.suspend(() => {
            const cleared =
              shown.agentStatuses.length === 0 && shown.backgroundToolCalls.length === 0

            if (cleared && !agentStatuses.has(conversationId)) return Effect.void

            if (cleared) agentStatuses.delete(conversationId)
            else agentStatuses.set(conversationId, shown)

            return PubSub.publish(published, { conversationId, update: shown })
          }),
        )

      const waitingParts = (conversationId?: string) =>
        sql`
          SELECT t.conversation_id AS conversationId, t.sent_at AS sentAt, p.part AS part
          FROM conversation_turn_part p JOIN conversation_turn t ON t.id = p.turn_id
          WHERE ${sql.and([
            ...(conversationId === undefined ? [] : [sql`t.conversation_id = ${conversationId}`]),
            sql`json_extract(p.part, '$._tag') IN ${sql.in(requestPartTags)}`,
            "json_extract(p.part, '$.status') = 'waiting'",
          ])}
          ORDER BY t.rowid, p.position
        `.pipe(
          Effect.flatMap(decodeWaiting),
          Effect.map((rows) =>
            rows.flatMap(({ conversationId: owner, sentAt, part }) =>
              isWaiting(part) ? [{ conversationId: owner, sentAt, part }] : [],
            ),
          ),
        )

      const seeded = yield* waitingParts().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read the waiting requests", cause).pipe(Effect.as([])),
        ),
      )

      const waiting = yield* SubscriptionRef.make<WaitingByConversation>(
        new Map(
          Object.entries(Arr.groupBy(seeded, ({ conversationId }) => conversationId)).map(
            ([conversationId, rows]) =>
              [
                conversationId,
                Arr.map(rows, ({ part, sentAt }) => ({ part, since: sentAt })),
              ] as const,
          ),
        ),
      )

      const markWaiting = Effect.fnUntraced(function* (
        conversationId: string,
        parts: ReadonlyArray<RequestPart>,
      ) {
        const now = yield* DateTime.now

        yield* SubscriptionRef.update(waiting, (current) => {
          const before = current.get(conversationId) ?? []

          const requests = parts.map((part) => ({
            part,
            since:
              before.find((request) => request.part.requestId === part.requestId)?.since ?? now,
          }))

          const next = new Map(current)

          if (Arr.isReadonlyArrayNonEmpty(requests)) next.set(conversationId, requests)
          else next.delete(conversationId)

          return next
        })
      })

      const lastEnds = (conditions: ReadonlyArray<string | Statement.Fragment>) =>
        sql`
          SELECT a.id AS conversationId, t.ended AS ended
          FROM (
            SELECT id, turn_seen_at FROM conversation
            UNION ALL SELECT session_id, turn_seen_at FROM global_conversation
          ) a
          JOIN conversation_turn t ON t.rowid = (SELECT MAX(rowid) FROM conversation_turn WHERE conversation_id = a.id)
          WHERE ${sql.and(["t.ended IS NOT NULL", ...conditions])}
        `.pipe(Effect.flatMap(decodeEnds))

      const unseenEnds = (conversationId?: string) =>
        lastEnds([
          ...(conversationId === undefined ? [] : [sql`a.id = ${conversationId}`]),
          "(a.turn_seen_at IS NULL OR json_extract(t.ended, '$.at') > a.turn_seen_at)",
        ])

      const unseen = yield* SubscriptionRef.make<UnseenByConversation>(
        new Map(
          (yield* unseenEnds().pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't read the unseen Turns", cause).pipe(Effect.as([])),
            ),
          )).map(({ conversationId, ended }) => [conversationId, ended] as const),
        ),
      )

      const setUnseen = (conversationId: string, ended: TurnEnd | undefined) =>
        SubscriptionRef.updateSome(unseen, (current) => {
          const before = current.get(conversationId)

          if (
            before === undefined
              ? ended === undefined
              : ended !== undefined && sameEnd(before, ended)
          )
            return Option.none()

          const next = new Map(current)

          if (ended === undefined) next.delete(conversationId)
          else next.set(conversationId, ended)

          return Option.some(next)
        })

      const refreshUnseen = (conversationId: string) =>
        unseenEnds(conversationId).pipe(
          Effect.flatMap(([row]) => setUnseen(conversationId, row?.ended)),
        )

      const runningConversations = yield* SubscriptionRef.make<ReadonlySet<string>>(
        new Set(
          (yield* sql`SELECT DISTINCT conversation_id AS id FROM conversation_turn WHERE ended IS NULL`.pipe(
            Effect.flatMap(decodeTurnIds),
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't read the running Turns", cause).pipe(Effect.as([])),
            ),
          )).map(({ id }) => id),
        ),
      )

      const setRunning = (conversationId: string, isRunning: boolean) =>
        SubscriptionRef.updateSome(runningConversations, (current) => {
          if (current.has(conversationId) === isRunning) return Option.none()

          const next = new Set(current)

          if (isRunning) next.add(conversationId)
          else next.delete(conversationId)

          return Option.some(next)
        })

      const lockFor = (conversationId: string) => {
        const lock = locks.get(conversationId) ?? Semaphore.makeUnsafe(1)
        locks.set(conversationId, lock)

        return lock
      }

      const askedStops = new Set<string>()

      const askedToStop = (turnId: string) =>
        Effect.sync(() => {
          askedStops.add(turnId)
        })

      const failedAlready = (turnId: string) =>
        sql`
          SELECT id FROM conversation_turn
          WHERE id = ${turnId} AND json_extract(ended, '$.ending._tag') = 'Failed'
        `.pipe(Effect.map((rows) => rows.length > 0))

      const unlessFailed = <E, R>(turnId: string, write: Effect.Effect<boolean, E, R>) =>
        failedAlready(turnId).pipe(
          Effect.flatMap((failed) => (failed ? Effect.succeed(false) : write)),
        )

      const writeApplied = (conversationId: string, event: AgentEvent) =>
        Match.value(event).pipe(
          Match.tagsExhaustive({
            TurnStarted: ({ turnId, message, images, context, feedback, sentAt }) =>
              sql`INSERT INTO conversation_turn ${sql.insert({
                id: turnId,
                conversation_id: conversationId,
                message,
                images: encodeImages(images),
                context: encodeContext(context),
                feedback: encodeFeedback(feedback),
                sent_at: DateTime.formatIso(sentAt),
              })}`.pipe(Effect.as(true)),
            PartSet: ({ turnId, index, part }) =>
              unlessFailed(
                turnId,
                sql`
                  INSERT INTO conversation_turn_part ${sql.insert({ turn_id: turnId, position: index, part: encodePart(part) })}
                  ON CONFLICT (turn_id, position) DO UPDATE SET part = excluded.part
                `.pipe(Effect.as(true)),
              ),
            PartAppended: ({ turnId, index, text }) =>
              unlessFailed(
                turnId,
                sql`
                  UPDATE conversation_turn_part
                  SET part = json_set(part, '$.text', json_extract(part, '$.text') || ${text})
                  WHERE turn_id = ${turnId} AND position = ${index}
                `.pipe(Effect.as(true)),
              ),
            TurnEnded: ({ turnId, ended }) => {
              const conditions = [
                sql`id = ${turnId}`,
                sql`(ended IS NULL OR json_extract(ended, '$.ending._tag') = 'CutOff')`,
              ]

              if (Predicate.isTagged(ended.ending, "Stopped") && !askedStops.has(turnId))
                conditions.push(
                  sql`COALESCE(json_extract(context, '$._tag'), '') != 'GlobalConversationUpdate'`,
                )

              return sql`
                UPDATE conversation_turn SET ended = ${encodeEnd(ended)}
                WHERE ${sql.and(conditions)}
                RETURNING id
              `.pipe(Effect.map((rows) => rows.length > 0))
            },
          }),
        )

      const runningTurn = (conversationId: string) =>
        sql`SELECT id FROM conversation_turn WHERE conversation_id = ${conversationId} AND ended IS NULL`.pipe(
          Effect.flatMap(decodeTurnIds),
          Effect.map(([turn]) => turn?.id ?? null),
        )

      const queued = (conversationId: string) =>
        sql`
          SELECT id, message, images, context, feedback FROM conversation_queued_message
          WHERE conversation_id = ${conversationId} ORDER BY position
        `.pipe(Effect.flatMap(decodeQueued))

      const queuedChanged = (conversationId: string) =>
        queued(conversationId).pipe(
          Effect.map((current) => QueuedMessagesChanged.make({ queued: current })),
        )

      const insertQueued = (conversationId: string, position: number, input: QueuedMessage) =>
        sql`INSERT INTO conversation_queued_message ${sql.insert({
          id: input.id,
          conversation_id: conversationId,
          position,
          message: input.message,
          images: encodeImages(input.images),
          context: encodeContext(input.context),
          feedback: encodeFeedback(input.feedback),
        })}`

      const queuedPositions = (conversationId: string) =>
        sql`
          SELECT MIN(position) AS first, MAX(position) AS last
          FROM conversation_queued_message WHERE conversation_id = ${conversationId}
        `.pipe(
          Effect.flatMap(decodePositions),
          Effect.map(([found]) => ({ first: found?.first ?? 0, last: found?.last ?? 0 })),
        )

      const execute = Effect.fnUntraced(function* (
        conversationId: string,
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

              yield* writeApplied(conversationId, event)
              started.push(event)
              break
            }

            case "enqueue":
              yield* insertQueued(
                conversationId,
                (yield* queuedPositions(conversationId)).last + 1,
                write.message,
              )
              break
            case "prepend": {
              const start = (yield* queuedPositions(conversationId)).first - write.messages.length

              yield* Effect.forEach(
                write.messages,
                (message, index) => insertQueued(conversationId, start + index, message),
                { discard: true },
              )
              break
            }

            case "dequeue":
              yield* sql`DELETE FROM conversation_queued_message WHERE id = ${write.queuedId}`
              break
          }

        return writes.some(({ type }) => type !== "startTurn")
          ? [yield* queuedChanged(conversationId), ...started]
          : started
      })

      const conversation = Effect.fnUntraced(function* (conversationId: string) {
        return {
          running: yield* runningTurn(conversationId),
          queued: yield* queued(conversationId),
        } satisfies ConversationState
      })

      const step = Effect.fnUntraced(function* (conversationId: string, event: ConversationEvent) {
        const { outcome, writes } = stepConversation(yield* conversation(conversationId), event)

        return { outcome, updates: yield* execute(conversationId, writes) }
      })

      const changeWith = <A, E, R>(
        conversationId: string,
        effect: Effect.Effect<
          readonly [A, ReadonlyArray<TranscriptUpdate>, ReadonlyArray<AgentEvent>?],
          E,
          R
        >,
      ) =>
        lockFor(conversationId).withPermits(1)(
          Effect.gen(function* () {
            const [decided, decidedUpdates, reported = []] = yield* sql.withTransaction(effect)
            const updates: ReadonlyArray<TranscriptUpdate> = [...reported, ...decidedUpdates]

            if (updates.some(changesRequest))
              yield* markWaiting(
                conversationId,
                (yield* waitingParts(conversationId)).map(({ part }) => part),
              )

            if (updates.some(startsOrEndsTurn)) {
              yield* refreshUnseen(conversationId)
              yield* setRunning(conversationId, (yield* runningTurn(conversationId)) !== null)
            }

            yield* PubSub.publishAll(
              published,
              updates.map((update, index) => ({
                conversationId,
                update,
                reported: index < reported.length,
              })),
            )

            return decided
          }),
        )

      const change = <E, R>(
        conversationId: string,
        effect: Effect.Effect<ReadonlyArray<TranscriptUpdate>, E, R>,
      ) =>
        changeWith(
          conversationId,
          Effect.map(effect, (updates) => [undefined, updates] as const),
        )

      const recordTurn = Effect.fnUntraced(function* (
        conversationId: string,
        { turnId, ended: { at, ending } }: typeof TurnEnded.Type,
      ) {
        const [turn] = yield* sql`
          SELECT
            t.sent_at AS sentAt, a.harness, a.model, a.effort, a.sandbox_provider AS sandboxProvider,
            COUNT(p.turn_id) AS toolCalls,
            COUNT(CASE json_extract(p.part, '$.status') WHEN 'failed' THEN 1 END) AS failedToolCalls
          FROM conversation_turn t
          LEFT JOIN conversation a ON a.id = t.conversation_id
          LEFT JOIN conversation_turn_part p
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
            conversation_id: conversationId,
            turn_id: turnId,
            ending: ending._tag,
            harness: turn.harness,
            model: turn.model,
            effort: turn.effort,
            sandbox_provider: turn.sandboxProvider,
            tool_calls: turn.toolCalls,
            failed_tool_calls: turn.failedToolCalls,
          },
        })
      })

      const save = (
        conversationId: string,
        hostEvents: ReadonlyArray<HostEvent>,
        journal?: SavedThrough,
      ) => {
        const events = hostEvents.filter(
          (event): event is SavedEvent => !Predicate.isTagged(event, "AgentStatusesChanged"),
        )

        const shown = hostEvents.findLast((event) =>
          Predicate.isTagged(event, "AgentStatusesChanged"),
        )

        return changeWith(
          conversationId,
          Effect.gen(function* () {
            if (journal !== undefined)
              yield* sql`
                UPDATE conversation SET journal_host = ${journal.host}, journal_saved = ${journal.through}
                WHERE id = ${conversationId}
              `

            const written = yield* Effect.filter(joinConsecutiveAppends(events), (event) =>
              writeApplied(conversationId, event),
            )

            const ended = written.filter((event) => Predicate.isTagged(event, "TurnEnded"))

            const next = yield* Effect.forEach(
              ended,
              ({ ended: { ending }, steersNotTakenIn = [] }) =>
                step(conversationId, {
                  type: "turnEnded",
                  ending,
                  requeued: queuedAgain(steersNotTakenIn),
                }),
            )

            const reported = written.map((event) =>
              Predicate.isTagged(event, "TurnEnded")
                ? TurnEnded.make({ turnId: event.turnId, ended: event.ended })
                : event,
            )

            return [ended, next.flatMap(({ updates }) => updates), reported] as const
          }),
        ).pipe(
          Effect.tapError((cause) => Effect.logWarning("Couldn't save a transcript", cause)),
          Effect.mapError(storageFailure),
          Effect.flatMap((ended) =>
            Effect.forEach(ended, (event) => recordTurn(conversationId, event), {
              discard: true,
            }).pipe(
              Effect.catch((cause) => Effect.logWarning("Couldn't describe an ended Turn", cause)),
            ),
          ),
          Effect.andThen(
            shown === undefined ? Effect.void : setAgentStatuses(conversationId, shown),
          ),
        )
      }

      const turnPage = Effect.fnUntraced(function* (
        conversationId: string,
        limit: number,
        before?: string,
      ) {
        const latestFirst = yield* decodePagedTurns(
          yield* sql`
            SELECT rowid AS position, id, message, images, context, feedback, sent_at AS sentAt, ended
            FROM conversation_turn
            WHERE ${sql.and([
              sql`conversation_id = ${conversationId}`,
              ...(before === undefined
                ? []
                : [
                    sql`rowid < (SELECT rowid FROM conversation_turn WHERE id = ${before} AND conversation_id = ${conversationId})`,
                  ]),
            ])}
            ORDER BY rowid DESC LIMIT ${limit}
          `,
        )

        const turns = latestFirst.toReversed()
        const first = turns[0]

        if (first === undefined) return { turns: [], earlierTurns: 0 }

        const parts = yield* decodeParts(
          yield* sql`
            SELECT turn_id AS turnId, part FROM conversation_turn_part
            WHERE ${sql.in(
              "turn_id",
              turns.map(({ id }) => id),
            )}
            ORDER BY turn_id, position
          `,
        )

        const [earlier] = yield* decodeCount(
          yield* sql`
            SELECT COUNT(*) AS count FROM conversation_turn
            WHERE conversation_id = ${conversationId} AND rowid < ${first.position}
          `,
        )

        const byTurn = Map.groupBy(parts, ({ turnId }) => turnId)

        return {
          turns: turns.map(({ id, message, images, context, feedback, sentAt, ended }) => ({
            id,
            message,
            images,
            context,
            feedback,
            sentAt,
            ended,
            parts: (byTurn.get(id) ?? []).map(({ part }) => part),
          })),
          earlierTurns: earlier?.count ?? 0,
        }
      })

      const snapshot = Effect.fnUntraced(function* (conversationId: string, turns = RECENT_TURNS) {
        return TranscriptSnapshot.make({
          ...(yield* turnPage(conversationId, turns)),
          queued: yield* queued(conversationId),
          status: statuses.get(conversationId) ?? null,
          agentStatuses: agentStatuses.get(conversationId)?.agentStatuses ?? [],
          backgroundToolCalls: agentStatuses.get(conversationId)?.backgroundToolCalls ?? [],
        })
      })

      const endUnfinished = Effect.fnUntraced(function* (
        ending: TurnEnding,
        conversationIds: ReadonlyArray<string>,
        onlyTurnId: string | null,
      ) {
        if (conversationIds.length === 0) return

        const conditions = [sql`t.ended IS NULL`, sql.in("t.conversation_id", conversationIds)]

        if (onlyTurnId !== null) conditions.push(sql`t.id = ${onlyTurnId}`)

        if (Predicate.isTagged(ending, "CutOff") || Predicate.isTagged(ending, "Interrupted"))
          conditions.push(
            sql`COALESCE(json_extract(t.context, '$._tag'), '') != 'GlobalConversationUpdate'`,
          )

        const running = yield* sql`
          SELECT t.conversation_id AS conversationId, t.id AS turnId, p.part AS part
          FROM conversation_turn t LEFT JOIN conversation_turn_part p ON p.turn_id = t.id
          WHERE ${sql.and(conditions)}
          ORDER BY t.rowid, p.position
        `.pipe(Effect.flatMap(decodeRunning), Effect.mapError(storageFailure))

        const ended = { at: yield* DateTime.now, ending }

        for (const [runningConversation, rows] of Map.groupBy(
          running,
          (row) => row.conversationId,
        )) {
          const events = Array.from(
            Map.groupBy(rows, ({ turnId }) => turnId),
            ([turnId, found]) =>
              endTurnEvents(
                turnId,
                found.flatMap(({ part }) => (part === null ? [] : [part])),
                ended,
              ),
          )

          yield* save(runningConversation, events.flat())
        }

        yield* Effect.forEach(
          conversationIds,
          (conversationId) =>
            setAgentStatuses(conversationId, AgentStatusesChanged.make({ agentStatuses: [] })),
          {
            discard: true,
          },
        )
      })

      const endRunning = Effect.fn("Transcripts.endRunning")(
        (ending: TurnEnding, conversationIds: ReadonlyArray<string>) =>
          endUnfinished(ending, conversationIds, null),
      )

      const endTurn = Effect.fn("Transcripts.endTurn")(
        (ending: TurnEnding, conversationId: string, endedTurnId: string) =>
          endUnfinished(ending, [conversationId], endedTurnId),
      )

      const withStorageFailure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.catchIf(effect, isStorageError, (cause) =>
          Effect.logWarning(`Couldn't ${name}`, cause).pipe(Effect.andThen(storageFailure())),
        )

      return Transcripts.of({
        save,
        endRunning,
        endTurn,
        askedToStop,
        watch: (conversationId) =>
          Stream.unwrap(
            lockFor(conversationId).withPermits(1)(
              Effect.gen(function* () {
                const live = yield* PubSub.subscribe(published)
                const first = yield* snapshot(conversationId)

                return Stream.succeed<TranscriptUpdate>(first).pipe(
                  Stream.concat(
                    Stream.fromSubscription(live).pipe(
                      Stream.filter((entry) => entry.conversationId === conversationId),
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
        read: (conversationId, turns) =>
          withStorageFailure(
            "read a transcript",
            lockFor(conversationId).withPermits(1)(snapshot(conversationId, turns)),
          ),
        loadEarlier: (conversationId, before) =>
          withStorageFailure(
            "read earlier Turns",
            lockFor(conversationId).withPermits(1)(
              turnPage(conversationId, RECENT_TURNS, before).pipe(
                Effect.flatMap((page) =>
                  PubSub.publish(published, {
                    conversationId,
                    update: EarlierTurns.make({ before, ...page }),
                  }),
                ),
              ),
            ),
          ),
        runningTurn: (conversationId) =>
          withStorageFailure("read a running Turn", runningTurn(conversationId)),
        idle: (conversationId) =>
          withStorageFailure(
            "read whether a conversation is idle",
            conversation(conversationId).pipe(
              Effect.map((state) => state.running === null && state.queued.length === 0),
            ),
          ),
        runningMessage: (conversationId) =>
          withStorageFailure(
            "read a running Turn",
            sql`SELECT message FROM conversation_turn WHERE conversation_id = ${conversationId} AND ended IS NULL`.pipe(
              Effect.flatMap(decodeMessages),
              Effect.map(([turn]) => turn?.message ?? null),
            ),
          ),
        recoverGlobalConversationUpdates: (conversationIds) =>
          withStorageFailure(
            "recover Global conversation updates",
            Effect.forEach(conversationIds, (conversationId) =>
              lockFor(conversationId).withPermits(1)(
                Effect.gen(function* () {
                  const globalConversationUpdates = yield* sql`
                    SELECT id, message, images, context, feedback, sent_at AS sentAt, ended
                    FROM conversation_turn WHERE conversation_id = ${conversationId} AND ended IS NULL
                      AND json_extract(context, '$._tag') = 'GlobalConversationUpdate'
                  `.pipe(Effect.flatMap(decodeTurns))

                  // pi restores complete messages; discard streaming fragments before replaying.
                  for (const turn of globalConversationUpdates)
                    yield* sql`DELETE FROM conversation_turn_part WHERE turn_id = ${turn.id}`

                  if (globalConversationUpdates.length > 0)
                    yield* markWaiting(
                      conversationId,
                      (yield* waitingParts(conversationId)).map(({ part }) => part),
                    )

                  return globalConversationUpdates.map((turn) => ({
                    ...TurnStarted.make({
                      turnId: turn.id,
                      message: turn.message,
                      images: turn.images,
                      context: turn.context,
                      feedback: turn.feedback,
                      sentAt: turn.sentAt,
                    }),
                    conversationId,
                  }))
                }),
              ),
            ).pipe(Effect.map((globalConversationUpdates) => globalConversationUpdates.flat())),
          ),
        startGlobalConversationUpdate: (conversationId, globalConversationUpdate, record) =>
          withStorageFailure(
            "start a Turn",
            changeWith(
              conversationId,
              Effect.gen(function* () {
                const message = {
                  message: "",
                  images: [],
                  context: globalConversationUpdate,
                  feedback: [],
                  id: randomUUID(),
                }

                const { outcome, updates } = yield* step(conversationId, {
                  type: "globalConversationUpdate",
                  message,
                })

                if (outcome.type === "started") yield* record(message.id)

                return [undefined, updates] as const
              }),
            ),
          ),
        startOrQueue: (conversationId, sent, feedback = Effect.succeed([])) =>
          withStorageFailure(
            "send a message",
            changeWith(
              conversationId,
              Effect.gen(function* () {
                const message = { ...sent, feedback: yield* feedback, id: randomUUID() }
                const { outcome, updates } = yield* step(conversationId, { type: "send", message })

                return [outcome.type === "started" ? "started" : "queued", updates] as const
              }),
            ),
          ),
        prependQueued: (conversationId, inputs) =>
          withStorageFailure(
            "put messages back in front of the Queued ones",
            change(
              conversationId,
              execute(conversationId, [{ type: "prepend", messages: queuedAgain(inputs) }]),
            ),
          ),
        cancelQueued: (conversationId, queuedId, restore = () => Effect.void) =>
          withStorageFailure(
            "cancel a Queued message",
            change(
              conversationId,
              Effect.gen(function* () {
                const { outcome, updates } = yield* step(conversationId, {
                  type: "cancelQueued",
                  queuedId,
                })

                if (outcome.type === "canceled") {
                  yield* restore(outcome.feedback)

                  return updates
                }

                const [started] = yield* sql`
                  SELECT id FROM conversation_turn WHERE id = ${queuedId} AND conversation_id = ${conversationId}
                `.pipe(Effect.flatMap(decodeTurnIds))

                return started === undefined ? [] : yield* new QueuedMessageStarted()
              }),
            ),
          ),
        startQueued: (conversationId, queuedId) =>
          withStorageFailure(
            "start a Queued message",
            change(
              conversationId,
              Effect.flatMap(
                step(conversationId, { type: "sendQueued", queuedId }),
                ({ outcome, updates }) =>
                  outcome.type === "busy"
                    ? Effect.fail(new ConversationBusy())
                    : Effect.succeed(updates),
              ),
            ),
          ),
        subscribeStarted: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.flatMap(({ conversationId, update, reported }) =>
                Predicate.isTagged(update, "TurnStarted") && !reported
                  ? Stream.succeed({ ...update, conversationId })
                  : Stream.empty,
              ),
            ),
          ),
        ),
        subscribeEnded: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.filter(({ update }) => Predicate.isTagged(update, "TurnEnded")),
              Stream.map(({ conversationId }) => conversationId),
            ),
          ),
        ),
        lastEnds: (conversationIds) =>
          withStorageFailure(
            "read how Turns ended",
            conversationIds.length === 0
              ? Effect.succeed(new Map())
              : lastEnds([sql.in("a.id", conversationIds)]).pipe(
                  Effect.map(
                    (rows) =>
                      new Map(rows.map(({ conversationId, ended }) => [conversationId, ended])),
                  ),
                ),
          ),
        waiting: SubscriptionRef.changes(waiting),
        waitingNow: SubscriptionRef.get(waiting),
        isWaiting: (conversationId) =>
          SubscriptionRef.get(waiting).pipe(Effect.map((current) => current.has(conversationId))),
        unseen: SubscriptionRef.changes(unseen),
        running: SubscriptionRef.changes(runningConversations),
        markSeen: (conversationId, endedAt) => {
          const at = DateTime.formatIso(endedAt)

          return withStorageFailure(
            "mark a Turn seen",
            lockFor(conversationId).withPermits(1)(
              Effect.all(
                [
                  sql`
                    UPDATE conversation SET turn_seen_at = ${at}
                    WHERE id = ${conversationId} AND (turn_seen_at IS NULL OR turn_seen_at < ${at})
                  `,
                  sql`
                    UPDATE global_conversation SET turn_seen_at = ${at}
                    WHERE session_id = ${conversationId} AND (turn_seen_at IS NULL OR turn_seen_at < ${at})
                  `,
                ],
                { discard: true },
              ).pipe(Effect.andThen(refreshUnseen(conversationId))),
            ),
          )
        },
        setStatus: (conversationId, status) =>
          lockFor(conversationId).withPermits(1)(
            Effect.suspend(() => {
              if (status === null) statuses.delete(conversationId)
              else statuses.set(conversationId, status)

              return PubSub.publish(published, {
                conversationId,
                update: StatusChanged.make({ status }),
              })
            }),
          ),
        remove: Effect.fn("Transcripts.remove")(function* (conversationId: string) {
          yield* lockFor(conversationId).withPermits(1)(
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM conversation_turn_part
                WHERE turn_id IN (SELECT id FROM conversation_turn WHERE conversation_id = ${conversationId})
              `
              yield* sql`DELETE FROM conversation_turn WHERE conversation_id = ${conversationId}`
              yield* sql`DELETE FROM conversation_queued_message WHERE conversation_id = ${conversationId}`
            }).pipe(sql.withTransaction),
          )
          locks.delete(conversationId)
          statuses.delete(conversationId)
          agentStatuses.delete(conversationId)
          yield* markWaiting(conversationId, [])
          yield* setUnseen(conversationId, undefined)
          yield* setRunning(conversationId, false)
        }, Effect.mapError(storageFailure)),
      })
    }),
  )
}

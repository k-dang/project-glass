import {
  Thread,
  ThreadError,
  type AgentEvent,
  endTurnEvents,
  AgentStatusesChanged,
  FeedbackNote,
  isRequestPart,
  isWaiting,
  Image,
  type MessageDelivery,
  PartAppended,
  ThreadBusy,
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
  TurnFailed,
  TurnContext,
  CapturedContext,
  EarlierTurns,
  type MessageWithContext,
  TurnPart,
  TurnStarted,
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
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"
import { randomUUID } from "node:crypto"
import {
  type ThreadEvent,
  type ThreadState,
  type ThreadWrite,
  type StartingTurn,
  stepThread,
} from "./threadState"
import type { HostEvent } from "./agentHost/protocol"
import type { SavedThrough } from "./hostJournal"
import { keyedLock } from "./keyedLock"
import { recordUnit } from "./wideEvents"

const encodePart = Schema.encodeSync(Schema.fromJsonString(TurnPart))

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

const ImagesJson = Schema.fromJsonString(Schema.Array(Image))

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
      threadId: Schema.String,
      turnId: Schema.String,
      part: Schema.NullOr(Schema.fromJsonString(TurnPart)),
    }),
  ),
)

const decodeWaiting = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      sentAt: Turn.fields.sentAt,
      part: Schema.fromJsonString(TurnPart),
    }),
  ),
)

const decodeEnds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: Schema.String, ended: Schema.fromJsonString(TurnEnd) })),
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
      harness: Schema.NullOr(Thread.fields.harness),
      model: Schema.NullOr(Thread.fields.model),
      effort: Schema.NullOr(Thread.fields.effort),
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
  readonly threadId: string
  readonly update: TranscriptUpdate
  readonly reported?: boolean
}

export interface WaitingRequest {
  readonly part: RequestPart
  readonly since: DateTime.Utc
}

export type WaitingByThread = ReadonlyMap<string, Arr.NonEmptyReadonlyArray<WaitingRequest>>

type UnseenByThread = ReadonlyMap<string, TurnEnd>

export type StartedTurn = typeof TurnStarted.Type & { readonly threadId: string }

export type IdleTurn = Omit<StartingTurn, "id" | "feedback">

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
  new ThreadError({
    message: "Couldn't read or save the Thread's transcript. Try again.",
  })

const queuedAgain = (inputs: ReadonlyArray<MessageWithContext>): ReadonlyArray<QueuedMessage> =>
  inputs.map((input) => ({ ...input, feedback: [], id: randomUUID() }))

type SavedEvent = Exclude<HostEvent, AgentStatusesChanged>

export class Transcripts extends Context.Service<
  Transcripts,
  {
    readonly save: (
      threadId: string,
      events: ReadonlyArray<HostEvent>,
      journal?: SavedThrough,
    ) => Effect.Effect<void, ThreadError>
    readonly watch: (threadId: string) => Stream.Stream<TranscriptUpdate, ThreadError>
    readonly read: (threadId: string, turns?: number) => Effect.Effect<Transcript, ThreadError>
    readonly loadEarlier: (threadId: string, before: string) => Effect.Effect<void, ThreadError>
    readonly endRunning: (
      ending: TurnEnding,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, ThreadError>
    readonly endTurn: (
      ending: TurnEnding,
      threadId: string,
      turnId: string,
    ) => Effect.Effect<void, ThreadError>
    readonly askedToStop: (turnId: string) => Effect.Effect<void, ThreadError>
    readonly runningTurn: (threadId: string) => Effect.Effect<string | null, ThreadError>
    readonly idle: (threadId: string) => Effect.Effect<boolean, ThreadError>
    readonly startIfIdle: (
      threadId: string,
      turn: IdleTurn,
      record: (turnId: string) => Effect.Effect<void, ThreadError>,
    ) => Effect.Effect<void, ThreadError>
    readonly settleUndelivered: (
      threadId: string,
      turnId: string,
      reason: string,
    ) => Effect.Effect<"failed" | "pending", ThreadError>
    readonly retryDeliveries: (
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<StartedTurn>, ThreadError>
    readonly runningMessage: (threadId: string) => Effect.Effect<string | null, ThreadError>
    readonly startOrQueue: (
      threadId: string,
      input: MessageWithContext,
      feedback?: Effect.Effect<ReadonlyArray<FeedbackNote>, ThreadError>,
    ) => Effect.Effect<MessageDelivery, ThreadError>
    readonly prependQueued: (
      threadId: string,
      inputs: ReadonlyArray<MessageWithContext>,
    ) => Effect.Effect<void, ThreadError>
    readonly cancelQueued: (
      threadId: string,
      queuedId: string,
      restore?: (feedback: ReadonlyArray<FeedbackNote>) => Effect.Effect<void, ThreadError>,
    ) => Effect.Effect<void, QueuedMessageStarted | ThreadError>
    readonly startQueued: (
      threadId: string,
      queuedId: string,
    ) => Effect.Effect<void, ThreadBusy | ThreadError>
    readonly subscribeStarted: Effect.Effect<Stream.Stream<StartedTurn>, never, Scope.Scope>
    readonly subscribeEnded: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>
    readonly subscribeMaybeIdle: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>
    readonly lastEnds: (
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyMap<string, TurnEnd>, ThreadError>
    readonly waiting: Stream.Stream<WaitingByThread>
    readonly waitingNow: Effect.Effect<WaitingByThread>
    readonly isWaiting: (threadId: string) => Effect.Effect<boolean>
    readonly unseen: Stream.Stream<UnseenByThread>
    readonly running: Stream.Stream<ReadonlySet<string>>
    readonly markSeen: (threadId: string, endedAt: DateTime.Utc) => Effect.Effect<void, ThreadError>
    readonly setStatus: (threadId: string, status: string | null) => Effect.Effect<void>
    readonly remove: (threadId: string) => Effect.Effect<void, ThreadError>
  }
>()("@glass/server/Transcripts") {
  static readonly layer = Layer.effect(
    Transcripts,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const published = yield* PubSub.unbounded<Published>()
      const withThread = keyedLock().withLock
      const statuses = new Map<string, string>()
      const agentStatuses = new Map<string, AgentStatusesChanged>()

      const setAgentStatuses = (threadId: string, shown: AgentStatusesChanged) =>
        withThread(
          threadId,
          Effect.suspend(() => {
            const cleared =
              shown.agentStatuses.length === 0 && shown.backgroundToolCalls.length === 0

            if (cleared && !agentStatuses.has(threadId)) return Effect.void

            if (cleared) agentStatuses.delete(threadId)
            else agentStatuses.set(threadId, shown)

            return PubSub.publish(published, { threadId, update: shown })
          }),
        )

      const waitingParts = (threadId?: string) =>
        sql`
          SELECT t.thread_id AS threadId, t.sent_at AS sentAt, p.part AS part
          FROM thread_turn_part p JOIN thread_turn t ON t.id = p.turn_id
          WHERE ${sql.and([
            ...(threadId === undefined ? [] : [sql`t.thread_id = ${threadId}`]),
            sql`json_extract(p.part, '$._tag') IN ${sql.in(requestPartTags)}`,
            "json_extract(p.part, '$.status') = 'waiting'",
          ])}
          ORDER BY t.rowid, p.position
        `.pipe(
          Effect.flatMap(decodeWaiting),
          Effect.map((rows) =>
            rows.flatMap(({ threadId: owner, sentAt, part }) =>
              isWaiting(part) ? [{ threadId: owner, sentAt, part }] : [],
            ),
          ),
        )

      const seeded = yield* waitingParts().pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read the waiting requests", cause).pipe(Effect.as([])),
        ),
      )

      const waiting = yield* SubscriptionRef.make<WaitingByThread>(
        new Map(
          Object.entries(Arr.groupBy(seeded, ({ threadId }) => threadId)).map(
            ([threadId, rows]) =>
              [threadId, Arr.map(rows, ({ part, sentAt }) => ({ part, since: sentAt }))] as const,
          ),
        ),
      )

      const markWaiting = Effect.fnUntraced(function* (
        threadId: string,
        parts: ReadonlyArray<RequestPart>,
      ) {
        const now = yield* DateTime.now

        yield* SubscriptionRef.update(waiting, (current) => {
          const before = current.get(threadId) ?? []

          const requests = parts.map((part) => ({
            part,
            since:
              before.find((request) => request.part.requestId === part.requestId)?.since ?? now,
          }))

          const next = new Map(current)

          if (Arr.isReadonlyArrayNonEmpty(requests)) next.set(threadId, requests)
          else next.delete(threadId)

          return next
        })
      })

      const lastEnds = (conditions: ReadonlyArray<string | Statement.Fragment>) =>
        sql`
          SELECT a.id AS threadId, t.ended AS ended
          FROM (
            SELECT id, turn_seen_at FROM thread
            UNION ALL SELECT id, turn_seen_at FROM global_chat_session WHERE ended_at IS NULL
          ) a
          JOIN thread_turn t ON t.rowid = (SELECT MAX(rowid) FROM thread_turn WHERE thread_id = a.id)
          WHERE ${sql.and(["t.ended IS NOT NULL", ...conditions])}
        `.pipe(Effect.flatMap(decodeEnds))

      const unseenEnds = (threadId?: string) =>
        lastEnds([
          ...(threadId === undefined ? [] : [sql`a.id = ${threadId}`]),
          "(a.turn_seen_at IS NULL OR json_extract(t.ended, '$.at') > a.turn_seen_at)",
        ])

      const unseen = yield* SubscriptionRef.make<UnseenByThread>(
        new Map(
          (yield* unseenEnds().pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't read the unseen Turns", cause).pipe(Effect.as([])),
            ),
          )).map(({ threadId, ended }) => [threadId, ended] as const),
        ),
      )

      const setUnseen = (threadId: string, ended: TurnEnd | undefined) =>
        SubscriptionRef.updateSome(unseen, (current) => {
          const before = current.get(threadId)

          if (
            before === undefined
              ? ended === undefined
              : ended !== undefined && sameEnd(before, ended)
          )
            return Option.none()

          const next = new Map(current)

          if (ended === undefined) next.delete(threadId)
          else next.set(threadId, ended)

          return Option.some(next)
        })

      const refreshUnseen = (threadId: string) =>
        unseenEnds(threadId).pipe(Effect.flatMap(([row]) => setUnseen(threadId, row?.ended)))

      const runningThreads = yield* SubscriptionRef.make<ReadonlySet<string>>(
        new Set(
          (yield* sql`SELECT DISTINCT thread_id AS id FROM thread_turn WHERE ended IS NULL`.pipe(
            Effect.flatMap(decodeTurnIds),
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't read the running Turns", cause).pipe(Effect.as([])),
            ),
          )).map(({ id }) => id),
        ),
      )

      const setRunning = (threadId: string, isRunning: boolean) =>
        SubscriptionRef.updateSome(runningThreads, (current) => {
          if (current.has(threadId) === isRunning) return Option.none()

          const next = new Set(current)

          if (isRunning) next.add(threadId)
          else next.delete(threadId)

          return Option.some(next)
        })

      const failedAlready = (turnId: string) =>
        sql`
          SELECT id FROM thread_turn
          WHERE id = ${turnId} AND json_extract(ended, '$.ending._tag') = 'Failed'
        `.pipe(Effect.map((rows) => rows.length > 0))

      const unlessFailed = <E, R>(turnId: string, write: Effect.Effect<boolean, E, R>) =>
        failedAlready(turnId).pipe(
          Effect.flatMap((failed) => (failed ? Effect.succeed(false) : write)),
        )

      const insertTurn = (
        threadId: string,
        { turnId, message, images, context, feedback, sentAt }: typeof TurnStarted.Type,
        retriesDelivery: boolean,
      ) =>
        sql`INSERT INTO thread_turn ${sql.insert({
          id: turnId,
          thread_id: threadId,
          message,
          images: encodeImages(images),
          context: encodeContext(context),
          feedback: encodeFeedback(feedback),
          sent_at: DateTime.formatIso(sentAt),
          retries_delivery: retriesDelivery ? 1 : 0,
        })}`.pipe(Effect.as(true))

      const writeApplied = (threadId: string, event: AgentEvent) =>
        Match.value(event).pipe(
          Match.tagsExhaustive({
            TurnStarted: (started) => insertTurn(threadId, started, false),
            PartSet: ({ turnId, index, part }) =>
              unlessFailed(
                turnId,
                sql`
                  INSERT INTO thread_turn_part ${sql.insert({ turn_id: turnId, position: index, part: encodePart(part) })}
                  ON CONFLICT (turn_id, position) DO UPDATE SET part = excluded.part
                `.pipe(Effect.as(true)),
              ),
            PartAppended: ({ turnId, index, text }) =>
              unlessFailed(
                turnId,
                sql`
                  UPDATE thread_turn_part
                  SET part = json_set(part, '$.text', json_extract(part, '$.text') || ${text})
                  WHERE turn_id = ${turnId} AND position = ${index}
                `.pipe(Effect.as(true)),
              ),
            ToolCallStatusSet: ({ toolCallId, status }) =>
              sql`
                UPDATE thread_turn_part SET part = json_set(part, '$.status', ${status})
                WHERE json_extract(part, '$._tag') = 'ToolCall'
                  AND json_extract(part, '$.toolCallId') = ${toolCallId}
                  AND turn_id IN (
                    SELECT id FROM thread_turn
                    WHERE thread_id = ${threadId}
                      AND json_extract(ended, '$.ending._tag') IS NOT 'Failed'
                  )
                RETURNING turn_id
              `.pipe(Effect.map((rows) => rows.length > 0)),
            TurnEnded: ({ turnId, ended }) => {
              const conditions = [
                sql`id = ${turnId}`,
                sql`(ended IS NULL OR json_extract(ended, '$.ending._tag') = 'CutOff')`,
              ]

              if (Predicate.isTagged(ended.ending, "Stopped"))
                conditions.push(sql`retries_delivery = 0`)

              return sql`
                UPDATE thread_turn SET ended = ${encodeEnd(ended)}
                WHERE ${sql.and(conditions)}
                RETURNING id
              `.pipe(Effect.map((rows) => rows.length > 0))
            },
          }),
        )

      const runningTurn = (threadId: string) =>
        sql`SELECT id FROM thread_turn WHERE thread_id = ${threadId} AND ended IS NULL`.pipe(
          Effect.flatMap(decodeTurnIds),
          Effect.map(([turn]) => turn?.id ?? null),
        )

      const queued = (threadId: string) =>
        sql`
          SELECT id, message, images, context, feedback FROM thread_queued_message
          WHERE thread_id = ${threadId} ORDER BY position
        `.pipe(Effect.flatMap(decodeQueued))

      const queuedChanged = (threadId: string) =>
        queued(threadId).pipe(
          Effect.map((current) => QueuedMessagesChanged.make({ queued: current })),
        )

      const insertQueued = (threadId: string, position: number, input: QueuedMessage) =>
        sql`INSERT INTO thread_queued_message ${sql.insert({
          id: input.id,
          thread_id: threadId,
          position,
          message: input.message,
          images: encodeImages(input.images),
          context: encodeContext(input.context),
          feedback: encodeFeedback(input.feedback),
        })}`

      const queuedPositions = (threadId: string) =>
        sql`
          SELECT MIN(position) AS first, MAX(position) AS last
          FROM thread_queued_message WHERE thread_id = ${threadId}
        `.pipe(
          Effect.flatMap(decodePositions),
          Effect.map(([found]) => ({ first: found?.first ?? 0, last: found?.last ?? 0 })),
        )

      const execute = Effect.fnUntraced(function* (
        threadId: string,
        writes: ReadonlyArray<ThreadWrite>,
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

              yield* insertTurn(threadId, event, write.message.retriesDelivery)
              started.push(event)
              break
            }

            case "enqueue":
              yield* insertQueued(
                threadId,
                (yield* queuedPositions(threadId)).last + 1,
                write.message,
              )
              break
            case "prepend": {
              const start = (yield* queuedPositions(threadId)).first - write.messages.length

              yield* Effect.forEach(
                write.messages,
                (message, index) => insertQueued(threadId, start + index, message),
                { discard: true },
              )
              break
            }

            case "dequeue":
              yield* sql`DELETE FROM thread_queued_message WHERE id = ${write.queuedId}`
              break
          }

        return writes.some(({ type }) => type !== "startTurn")
          ? [yield* queuedChanged(threadId), ...started]
          : started
      })

      const thread = Effect.fnUntraced(function* (threadId: string) {
        return {
          running: yield* runningTurn(threadId),
          queued: yield* queued(threadId),
        } satisfies ThreadState
      })

      const step = Effect.fnUntraced(function* (threadId: string, event: ThreadEvent) {
        const { outcome, writes } = stepThread(yield* thread(threadId), event)

        return { outcome, updates: yield* execute(threadId, writes) }
      })

      const changeWith = <A, E, R>(
        threadId: string,
        effect: Effect.Effect<
          readonly [A, ReadonlyArray<TranscriptUpdate>, ReadonlyArray<AgentEvent>?],
          E,
          R
        >,
      ) =>
        withThread(
          threadId,
          Effect.gen(function* () {
            const [decided, decidedUpdates, reported = []] = yield* sql.withTransaction(effect)
            const updates: ReadonlyArray<TranscriptUpdate> = [...reported, ...decidedUpdates]

            if (updates.some(changesRequest))
              yield* markWaiting(
                threadId,
                (yield* waitingParts(threadId)).map(({ part }) => part),
              )

            if (updates.some(startsOrEndsTurn)) {
              yield* refreshUnseen(threadId)
              yield* setRunning(threadId, (yield* runningTurn(threadId)) !== null)
            }

            yield* PubSub.publishAll(
              published,
              updates.map((update, index) => ({
                threadId,
                update,
                reported: index < reported.length,
              })),
            )

            return decided
          }),
        )

      const change = <E, R>(
        threadId: string,
        effect: Effect.Effect<ReadonlyArray<TranscriptUpdate>, E, R>,
      ) =>
        changeWith(
          threadId,
          Effect.map(effect, (updates) => [undefined, updates] as const),
        )

      const recordTurn = Effect.fnUntraced(function* (
        threadId: string,
        { turnId, ended: { at, ending } }: typeof TurnEnded.Type,
      ) {
        const [turn] = yield* sql`
          SELECT
            t.sent_at AS sentAt, a.harness, a.model, a.effort, a.sandbox_provider AS sandboxProvider,
            COUNT(p.turn_id) AS toolCalls,
            COUNT(CASE json_extract(p.part, '$.status') WHEN 'failed' THEN 1 END) AS failedToolCalls
          FROM thread_turn t
          LEFT JOIN thread a ON a.id = t.thread_id
          LEFT JOIN thread_turn_part p
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
            thread_id: threadId,
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
        threadId: string,
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
          threadId,
          Effect.gen(function* () {
            if (journal !== undefined)
              yield* sql`
                UPDATE thread SET journal_host = ${journal.host}, journal_saved = ${journal.through}
                WHERE id = ${threadId}
              `

            const written = yield* Effect.filter(joinConsecutiveAppends(events), (event) =>
              writeApplied(threadId, event),
            )

            const ended = written.filter((event) => Predicate.isTagged(event, "TurnEnded"))

            const next = yield* Effect.forEach(
              ended,
              ({ ended: { ending }, steersNotTakenIn = [] }) =>
                step(threadId, {
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
            Effect.forEach(ended, (event) => recordTurn(threadId, event), {
              discard: true,
            }).pipe(
              Effect.catch((cause) => Effect.logWarning("Couldn't describe an ended Turn", cause)),
            ),
          ),
          Effect.andThen(shown === undefined ? Effect.void : setAgentStatuses(threadId, shown)),
        )
      }

      const turnPage = Effect.fnUntraced(function* (
        threadId: string,
        limit: number,
        before?: string,
      ) {
        const latestFirst = yield* decodePagedTurns(
          yield* sql`
            SELECT rowid AS position, id, message, images, context, feedback, sent_at AS sentAt, ended
            FROM thread_turn
            WHERE ${sql.and([
              sql`thread_id = ${threadId}`,
              ...(before === undefined
                ? []
                : [
                    sql`rowid < (SELECT rowid FROM thread_turn WHERE id = ${before} AND thread_id = ${threadId})`,
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
            SELECT turn_id AS turnId, part FROM thread_turn_part
            WHERE ${sql.in(
              "turn_id",
              turns.map(({ id }) => id),
            )}
            ORDER BY turn_id, position
          `,
        )

        const [earlier] = yield* decodeCount(
          yield* sql`
            SELECT COUNT(*) AS count FROM thread_turn
            WHERE thread_id = ${threadId} AND rowid < ${first.position}
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

      const snapshot = Effect.fnUntraced(function* (threadId: string, turns = RECENT_TURNS) {
        return TranscriptSnapshot.make({
          ...(yield* turnPage(threadId, turns)),
          queued: yield* queued(threadId),
          status: statuses.get(threadId) ?? null,
          agentStatuses: agentStatuses.get(threadId)?.agentStatuses ?? [],
          backgroundToolCalls: agentStatuses.get(threadId)?.backgroundToolCalls ?? [],
        })
      })

      const endUnfinished = Effect.fnUntraced(function* (
        ending: TurnEnding,
        threadIds: ReadonlyArray<string>,
        onlyTurnId: string | null,
      ) {
        if (threadIds.length === 0) return

        const conditions = [sql`t.ended IS NULL`, sql.in("t.thread_id", threadIds)]

        if (onlyTurnId !== null) conditions.push(sql`t.id = ${onlyTurnId}`)

        if (Predicate.isTagged(ending, "CutOff") || Predicate.isTagged(ending, "Interrupted"))
          conditions.push(sql`t.retries_delivery = 0`)

        const running = yield* sql`
          SELECT t.thread_id AS threadId, t.id AS turnId, p.part AS part
          FROM thread_turn t LEFT JOIN thread_turn_part p ON p.turn_id = t.id
          WHERE ${sql.and(conditions)}
          ORDER BY t.rowid, p.position
        `.pipe(Effect.flatMap(decodeRunning), Effect.mapError(storageFailure))

        const ended = { at: yield* DateTime.now, ending }

        for (const [runningThread, rows] of Map.groupBy(running, (row) => row.threadId)) {
          const events = Array.from(
            Map.groupBy(rows, ({ turnId }) => turnId),
            ([turnId, found]) =>
              endTurnEvents(
                turnId,
                found.flatMap(({ part }) => (part === null ? [] : [part])),
                ended,
              ),
          )

          yield* save(runningThread, events.flat())
        }

        yield* Effect.forEach(
          threadIds,
          (threadId) =>
            setAgentStatuses(threadId, AgentStatusesChanged.make({ agentStatuses: [] })),
          {
            discard: true,
          },
        )
      })

      const endRunning = Effect.fn("Transcripts.endRunning")(
        (ending: TurnEnding, threadIds: ReadonlyArray<string>) =>
          endUnfinished(ending, threadIds, null),
      )

      const endTurn = Effect.fn("Transcripts.endTurn")(
        (ending: TurnEnding, threadId: string, endedTurnId: string) =>
          endUnfinished(ending, [threadId], endedTurnId),
      )

      const setStatus = (threadId: string, status: string | null) =>
        withThread(
          threadId,
          Effect.suspend(() => {
            if (status === null) statuses.delete(threadId)
            else statuses.set(threadId, status)

            return PubSub.publish(published, {
              threadId,
              update: StatusChanged.make({ status }),
            })
          }),
        )

      const withStorageFailure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        Effect.catchIf(effect, isStorageError, (cause) =>
          Effect.logWarning(`Couldn't ${name}`, cause).pipe(Effect.andThen(storageFailure())),
        )

      return Transcripts.of({
        save,
        endRunning,
        endTurn,
        askedToStop: (turnId) =>
          withStorageFailure(
            "record that a Turn was asked to stop",
            sql`UPDATE thread_turn SET retries_delivery = 0 WHERE id = ${turnId}`,
          ),
        watch: (threadId) =>
          Stream.unwrap(
            withThread(
              threadId,
              Effect.gen(function* () {
                const live = yield* PubSub.subscribe(published)
                const first = yield* snapshot(threadId)

                return Stream.succeed<TranscriptUpdate>(first).pipe(
                  Stream.concat(
                    Stream.fromSubscription(live).pipe(
                      Stream.filter((entry) => entry.threadId === threadId),
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
        read: (threadId, turns) =>
          withStorageFailure("read a transcript", withThread(threadId, snapshot(threadId, turns))),
        loadEarlier: (threadId, before) =>
          withStorageFailure(
            "read earlier Turns",
            withThread(
              threadId,
              turnPage(threadId, RECENT_TURNS, before).pipe(
                Effect.flatMap((page) =>
                  PubSub.publish(published, {
                    threadId,
                    update: EarlierTurns.make({ before, ...page }),
                  }),
                ),
              ),
            ),
          ),
        runningTurn: (threadId) => withStorageFailure("read a running Turn", runningTurn(threadId)),
        idle: (threadId) =>
          withStorageFailure(
            "read whether a Thread is idle",
            thread(threadId).pipe(
              Effect.map((state) => state.running === null && state.queued.length === 0),
            ),
          ),
        runningMessage: (threadId) =>
          withStorageFailure(
            "read a running Turn",
            sql`SELECT message FROM thread_turn WHERE thread_id = ${threadId} AND ended IS NULL`.pipe(
              Effect.flatMap(decodeMessages),
              Effect.map(([turn]) => turn?.message ?? null),
            ),
          ),
        settleUndelivered: Effect.fnUntraced(function* (threadId, turnId, reason) {
          const retried = yield* withStorageFailure(
            "read whether a Turn retries delivery",
            sql`SELECT id FROM thread_turn WHERE id = ${turnId} AND retries_delivery = 1`,
          )

          if (retried.length > 0) {
            yield* setStatus(threadId, reason)

            return "pending" as const
          }

          const ended = { at: yield* DateTime.now, ending: TurnFailed.make({ reason }) }

          yield* save(threadId, [TurnEnded.make({ turnId, ended })])

          return "failed" as const
        }),
        retryDeliveries: (threadIds) =>
          withStorageFailure(
            "retry undelivered Turns",
            Effect.forEach(threadIds, (threadId) =>
              withThread(
                threadId,
                Effect.gen(function* () {
                  const retried = yield* sql`
                    SELECT id, message, images, context, feedback, sent_at AS sentAt, ended
                    FROM thread_turn
                    WHERE thread_id = ${threadId} AND ended IS NULL AND retries_delivery = 1
                  `.pipe(Effect.flatMap(decodeTurns))

                  for (const turn of retried)
                    yield* sql`DELETE FROM thread_turn_part WHERE turn_id = ${turn.id}`

                  if (retried.length > 0)
                    yield* markWaiting(
                      threadId,
                      (yield* waitingParts(threadId)).map(({ part }) => part),
                    )

                  return retried.map((turn) => ({
                    ...TurnStarted.make({
                      turnId: turn.id,
                      message: turn.message,
                      images: turn.images,
                      context: turn.context,
                      feedback: turn.feedback,
                      sentAt: turn.sentAt,
                    }),
                    threadId,
                  }))
                }),
              ),
            ).pipe(Effect.map((retried) => retried.flat())),
          ),
        startIfIdle: (threadId, turn, record) =>
          withStorageFailure(
            "start a Turn",
            changeWith(
              threadId,
              Effect.gen(function* () {
                const message = { ...turn, feedback: [], id: randomUUID() }

                const { outcome, updates } = yield* step(threadId, {
                  type: "startIfIdle",
                  message,
                })

                if (outcome.type === "started") yield* record(message.id)

                return [undefined, updates] as const
              }),
            ),
          ),
        startOrQueue: (threadId, sent, feedback = Effect.succeed([])) =>
          withStorageFailure(
            "send a message",
            changeWith(
              threadId,
              Effect.gen(function* () {
                const message = { ...sent, feedback: yield* feedback, id: randomUUID() }
                const { outcome, updates } = yield* step(threadId, { type: "send", message })

                return [outcome.type === "started" ? "started" : "queued", updates] as const
              }),
            ),
          ),
        prependQueued: (threadId, inputs) =>
          withStorageFailure(
            "put messages back in front of the Queued ones",
            change(
              threadId,
              execute(threadId, [{ type: "prepend", messages: queuedAgain(inputs) }]),
            ),
          ),
        cancelQueued: (threadId, queuedId, restore = () => Effect.void) =>
          withStorageFailure(
            "cancel a Queued message",
            change(
              threadId,
              Effect.gen(function* () {
                const { outcome, updates } = yield* step(threadId, {
                  type: "cancelQueued",
                  queuedId,
                })

                if (outcome.type === "canceled") {
                  yield* restore(outcome.feedback)

                  return updates
                }

                const [started] = yield* sql`
                  SELECT id FROM thread_turn WHERE id = ${queuedId} AND thread_id = ${threadId}
                `.pipe(Effect.flatMap(decodeTurnIds))

                return started === undefined ? [] : yield* new QueuedMessageStarted()
              }),
            ),
          ),
        startQueued: (threadId, queuedId) =>
          withStorageFailure(
            "start a Queued message",
            change(
              threadId,
              Effect.flatMap(
                step(threadId, { type: "sendQueued", queuedId }),
                ({ outcome, updates }) =>
                  outcome.type === "busy" ? Effect.fail(new ThreadBusy()) : Effect.succeed(updates),
              ),
            ),
          ),
        subscribeStarted: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.flatMap(({ threadId, update, reported }) =>
                Predicate.isTagged(update, "TurnStarted") && !reported
                  ? Stream.succeed({ ...update, threadId })
                  : Stream.empty,
              ),
            ),
          ),
        ),
        subscribeEnded: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.filter(({ update }) => Predicate.isTagged(update, "TurnEnded")),
              Stream.map(({ threadId }) => threadId),
            ),
          ),
        ),
        subscribeMaybeIdle: PubSub.subscribe(published).pipe(
          Effect.map((live) =>
            Stream.fromSubscription(live).pipe(
              Stream.filter(
                ({ update }) =>
                  Predicate.isTagged(update, "TurnEnded") ||
                  Predicate.isTagged(update, "QueuedMessagesChanged"),
              ),
              Stream.map(({ threadId }) => threadId),
            ),
          ),
        ),
        lastEnds: (threadIds) =>
          withStorageFailure(
            "read how Turns ended",
            threadIds.length === 0
              ? Effect.succeed(new Map())
              : lastEnds([sql.in("a.id", threadIds)]).pipe(
                  Effect.map(
                    (rows) => new Map(rows.map(({ threadId, ended }) => [threadId, ended])),
                  ),
                ),
          ),
        waiting: SubscriptionRef.changes(waiting),
        waitingNow: SubscriptionRef.get(waiting),
        isWaiting: (threadId) =>
          SubscriptionRef.get(waiting).pipe(Effect.map((current) => current.has(threadId))),
        unseen: SubscriptionRef.changes(unseen),
        running: SubscriptionRef.changes(runningThreads),
        markSeen: (threadId, endedAt) => {
          const at = DateTime.formatIso(endedAt)

          return withStorageFailure(
            "mark a Turn seen",
            withThread(
              threadId,
              Effect.all(
                [
                  sql`
                    UPDATE thread SET turn_seen_at = ${at}
                    WHERE id = ${threadId} AND (turn_seen_at IS NULL OR turn_seen_at < ${at})
                  `,
                  sql`
                    UPDATE global_chat_session SET turn_seen_at = ${at}
                    WHERE id = ${threadId} AND (turn_seen_at IS NULL OR turn_seen_at < ${at})
                  `,
                ],
                { discard: true },
              ).pipe(Effect.andThen(refreshUnseen(threadId))),
            ),
          )
        },
        setStatus,
        remove: Effect.fn("Transcripts.remove")(function* (threadId: string) {
          yield* withThread(
            threadId,
            Effect.gen(function* () {
              yield* sql`
                DELETE FROM thread_turn_part
                WHERE turn_id IN (SELECT id FROM thread_turn WHERE thread_id = ${threadId})
              `
              yield* sql`DELETE FROM thread_turn WHERE thread_id = ${threadId}`
              yield* sql`DELETE FROM thread_queued_message WHERE thread_id = ${threadId}`
            }).pipe(sql.withTransaction),
          )
          statuses.delete(threadId)
          agentStatuses.delete(threadId)
          yield* markWaiting(threadId, [])
          yield* setUnseen(threadId, undefined)
          yield* setRunning(threadId, false)
        }, Effect.mapError(storageFailure)),
      })
    }),
  )
}

import {
  AgentError,
  type AgentEvent,
  endTurnEvents,
  isRequestPart,
  Image,
  type MessageInput,
  PartAppended,
  AgentBusy,
  QueuedMessagesChanged,
  QueuedMessage,
  SentMessage,
  StatusChanged,
  TranscriptSnapshot,
  type TranscriptUpdate,
  Turn,
  TurnEnd,
  type TurnEnding,
  TurnInterrupted,
  TurnPart,
  TurnStarted,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
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
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"

const encodePart = Schema.encodeSync(Schema.fromJsonString(TurnPart))

const encodeEnd = Schema.encodeSync(Schema.fromJsonString(TurnEnd))

export const ImagesJson = Schema.fromJsonString(Schema.Array(Image))

export const encodeImages = Schema.encodeSync(ImagesJson)

const decodeTurns = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Turn.fields.id,
      message: Turn.fields.message,
      images: ImagesJson,
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
  Schema.Array(Schema.Struct({ ...QueuedMessage.fields, ...StoredMessage.fields })),
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

const startsNext = (event: TranscriptUpdate) =>
  Predicate.isTagged(event, "TurnEnded") &&
  (Predicate.isTagged(event.ended.ending, "Done") ||
    Predicate.isTagged(event.ended.ending, "Failed"))

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save the Agent's transcript. Try again." })

export class Transcripts extends Context.Service<
  Transcripts,
  {
    readonly save: (
      agentId: string,
      events: ReadonlyArray<AgentEvent>,
    ) => Effect.Effect<void, AgentError>
    readonly watch: (agentId: string) => Stream.Stream<TranscriptUpdate, AgentError>
    readonly endRunning: (
      ending: TurnEnding,
      agentIds?: ReadonlyArray<string>,
    ) => Effect.Effect<void, AgentError>
    readonly runningTurn: (agentId: string) => Effect.Effect<string | null, AgentError>
    readonly startOrQueue: (agentId: string, input: MessageInput) => Effect.Effect<void, AgentError>
    readonly prependQueued: (
      agentId: string,
      inputs: ReadonlyArray<MessageInput>,
    ) => Effect.Effect<void, AgentError>
    readonly cancelQueued: (agentId: string, queuedId: string) => Effect.Effect<void, AgentError>
    readonly startQueued: (
      agentId: string,
      queuedId: string,
    ) => Effect.Effect<void, AgentBusy | AgentError>
    readonly subscribeStarted: Effect.Effect<Stream.Stream<StartedTurn>, never, Scope.Scope>
    /** The Agents with a request waiting, again after every change. */
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

      // `isWaiting` as SQL, over the request parts `isRequestPart` names.
      const hasWaitingRequest = (agentId: string) =>
        sql`
          SELECT EXISTS (
            SELECT 1 FROM agent_turn_part p JOIN agent_turn t ON t.id = p.turn_id
            WHERE t.agent_id = ${agentId}
              AND json_extract(p.part, '$._tag') IN ('PermissionRequest', 'Question')
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
            TurnStarted: ({ turnId, message, images, sentAt }) =>
              sql`INSERT INTO agent_turn ${sql.insert({
                id: turnId,
                agent_id: agentId,
                message,
                images: encodeImages(images),
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
                WHERE id = ${turnId} AND ended IS NULL RETURNING id
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
          SELECT id, message, images FROM agent_queued_message
          WHERE agent_id = ${agentId} ORDER BY position
        `.pipe(Effect.flatMap(decodeQueued))

      const queuedChanged = (agentId: string) =>
        queued(agentId).pipe(
          Effect.map((current) => QueuedMessagesChanged.make({ queued: current })),
        )

      const insertQueued = (agentId: string, position: number, input: MessageInput) =>
        sql`INSERT INTO agent_queued_message ${sql.insert({
          id: randomUUID(),
          agent_id: agentId,
          position,
          message: input.message,
          images: encodeImages(input.images),
        })}`

      const queuedPositions = (agentId: string) =>
        sql`
          SELECT MIN(position) AS first, MAX(position) AS last
          FROM agent_queued_message WHERE agent_id = ${agentId}
        `.pipe(
          Effect.flatMap(decodePositions),
          Effect.map(([found]) => ({ first: found?.first ?? 0, last: found?.last ?? 0 })),
        )

      const startTurn = Effect.fnUntraced(function* (agentId: string, input: MessageInput) {
        const event = TurnStarted.make({
          turnId: randomUUID(),
          message: input.message,
          images: input.images,
          sentAt: yield* DateTime.now,
        })

        yield* writeApplied(agentId, event)

        return event
      })

      const startFromQueue = Effect.fnUntraced(function* (agentId: string, chosen: QueuedMessage) {
        yield* sql`DELETE FROM agent_queued_message WHERE id = ${chosen.id}`
        const turn = yield* startTurn(agentId, chosen)

        return [yield* queuedChanged(agentId), turn]
      })

      const change = <E, R>(
        agentId: string,
        effect: Effect.Effect<ReadonlyArray<TranscriptUpdate>, E, R>,
      ) =>
        lockFor(agentId).withPermits(1)(
          Effect.gen(function* () {
            const updates = yield* sql.withTransaction(effect)

            if (updates.some(changesRequest))
              yield* markWaiting(agentId, yield* hasWaitingRequest(agentId))

            yield* PubSub.publishAll(
              published,
              updates.map((update) => ({ agentId, update })),
            )
          }),
        )

      const startNext = Effect.fnUntraced(function* (agentId: string) {
        if ((yield* runningTurn(agentId)) !== null) return []

        const [head] = yield* queued(agentId)

        return head === undefined ? [] : yield* startFromQueue(agentId, head)
      })

      const save = Effect.fn("Transcripts.save")(
        function* (agentId: string, events: ReadonlyArray<AgentEvent>) {
          yield* change(
            agentId,
            Effect.gen(function* () {
              const written = yield* Effect.filter(joinConsecutiveAppends(events), (event) =>
                writeApplied(agentId, event),
              )

              return written.some(startsNext)
                ? [...written, ...(yield* startNext(agentId))]
                : written
            }),
          )
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't save a transcript", cause)),
        Effect.mapError(storageFailure),
      )

      const snapshot = Effect.fnUntraced(function* (agentId: string) {
        const turns = yield* decodeTurns(
          yield* sql`
            SELECT id, message, images, sent_at AS sentAt, ended
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
        agentIds?: ReadonlyArray<string>,
      ) {
        if (agentIds?.length === 0) return

        const running = yield* sql`
          SELECT t.agent_id AS agentId, t.id AS turnId, p.part AS part
          FROM agent_turn t LEFT JOIN agent_turn_part p ON p.turn_id = t.id
          WHERE ${sql.and(["t.ended IS NULL", ...(agentIds === undefined ? [] : [sql.in("t.agent_id", agentIds)])])}
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

      // Requests only wait in a running Turn, so this leaves none waiting.
      yield* endRunning(TurnInterrupted.make({})).pipe(Effect.orDie)

      const withStorageFailure = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.tapError((cause) =>
            Predicate.isTagged(cause, "AgentBusy")
              ? Effect.void
              : Effect.logWarning(`Couldn't ${name}`, cause),
          ),
          Effect.mapError((cause) =>
            Predicate.isTagged(cause, "AgentBusy") ? cause : storageFailure(),
          ),
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
        runningTurn: (agentId) => withStorageFailure("read a running Turn", runningTurn(agentId)),
        startOrQueue: (agentId, input) =>
          withStorageFailure(
            "send a message",
            change(
              agentId,
              Effect.gen(function* () {
                if ((yield* runningTurn(agentId)) === null)
                  return [yield* startTurn(agentId, input)]

                yield* insertQueued(agentId, (yield* queuedPositions(agentId)).last + 1, input)

                return [yield* queuedChanged(agentId)]
              }),
            ),
          ),
        prependQueued: (agentId, inputs) =>
          withStorageFailure(
            "put messages back in front of the Queued ones",
            change(
              agentId,
              Effect.gen(function* () {
                const start = (yield* queuedPositions(agentId)).first - inputs.length

                yield* Effect.forEach(
                  inputs,
                  (input, index) => insertQueued(agentId, start + index, input),
                  { discard: true },
                )

                return [yield* queuedChanged(agentId)]
              }),
            ),
          ),
        cancelQueued: (agentId, queuedId) =>
          withStorageFailure(
            "cancel a Queued message",
            change(
              agentId,
              Effect.gen(function* () {
                yield* sql`
                  DELETE FROM agent_queued_message WHERE id = ${queuedId} AND agent_id = ${agentId}
                `

                return [yield* queuedChanged(agentId)]
              }),
            ),
          ),
        startQueued: (agentId, queuedId) =>
          withStorageFailure(
            "start a Queued message",
            change(
              agentId,
              Effect.gen(function* () {
                if ((yield* runningTurn(agentId)) !== null) return yield* new AgentBusy()

                const chosen = (yield* queued(agentId)).find(({ id }) => id === queuedId)

                return chosen === undefined ? [] : yield* startFromQueue(agentId, chosen)
              }),
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

import { Event, EventLogError, EventPage, type EventSource, LoggedEvent } from "@glass/contracts"
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schema,
  type Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"

export const KEPT_FOR = Duration.days(30)

const encodeEvent = Schema.encodeEffect(Event)

const LoggedRow = Schema.Struct({
  ...LoggedEvent.fields,
  subject: Schema.String,
  event: Schema.fromJsonString(Event),
})

const decodeLogged = Schema.decodeUnknownEffect(LoggedRow)

const readable = (rows: ReadonlyArray<unknown>) =>
  Effect.forEach(rows, (row) =>
    decodeLogged(row).pipe(
      Effect.map(({ subject, ...logged }) =>
        Option.some({ subject, logged: new LoggedEvent(logged) }),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Skipped an unreadable Event", cause).pipe(
          Effect.as(Option.none<SubjectEvent>()),
        ),
      ),
    ),
  ).pipe(Effect.map((decoded) => decoded.flatMap(Option.toArray)))

const unavailable = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.tapError((cause) => Effect.logWarning("Couldn't read the Event log", cause)),
    Effect.mapError(() => new EventLogError({ message: "Couldn't load the Events. Try again." })),
  )

const decodeLatest = Schema.decodeUnknownEffect(
  Schema.Tuple([Schema.Struct({ latest: Schema.NullOr(Schema.Int) })]),
)

export interface NewEvent {
  readonly event: Event
  readonly subject: string
  readonly once?: string
}

export interface EventFilter {
  readonly limit: number
  readonly about?:
    | { readonly source: EventSource; readonly subjects: ReadonlyArray<string> }
    | undefined
  readonly since?: DateTime.Utc | undefined
}

export interface Cursor {
  readonly source: EventSource
  readonly subject: string
  readonly after: number
}

export interface SubjectEvent {
  readonly subject: string
  readonly logged: LoggedEvent
}

export class EventLog extends Context.Service<
  EventLog,
  {
    readonly record: (source: EventSource, events: ReadonlyArray<NewEvent>) => Effect.Effect<void>
    readonly list: (filter: EventFilter) => Effect.Effect<EventPage, EventLogError>
    readonly latestId: Effect.Effect<number, EventLogError>
    readonly after: (
      cursors: ReadonlyArray<Cursor>,
    ) => Effect.Effect<ReadonlyArray<SubjectEvent>, EventLogError>
    readonly changes: Stream.Stream<unknown>
  }
>()("@glass/server/EventLog") {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const recorded = yield* SubscriptionRef.make(0)

      const write = Effect.fnUntraced(
        function* (source: EventSource, { event, subject, once }: NewEvent, occurredAt: string) {
          const inserted = yield* sql`INSERT OR IGNORE INTO event ${sql.insert({
            source,
            kind: event._tag,
            subject,
            once: once ?? null,
            payload: JSON.stringify(yield* encodeEvent(event)),
            occurred_at: occurredAt,
          })} RETURNING id`

          return inserted.length > 0
        },
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't record an Event", cause).pipe(Effect.as(false)),
        ),
      )

      const deleteOld = Effect.gen(function* () {
        const oldest = DateTime.subtractDuration(yield* DateTime.now, KEPT_FOR)

        yield* sql`DELETE FROM event WHERE occurred_at < ${DateTime.formatIso(oldest)}`
      }).pipe(Effect.catch((cause) => Effect.logWarning("Couldn't delete old Events", cause)))

      yield* deleteOld

      const record = Effect.fn("EventLog.record")(function* (
        source: EventSource,
        events: ReadonlyArray<NewEvent>,
      ) {
        if (events.length === 0) return

        const occurredAt = DateTime.formatIso(yield* DateTime.now)

        const written = yield* Effect.forEach(events, (event) => write(source, event, occurredAt))

        if (written.some(Boolean)) yield* SubscriptionRef.update(recorded, (count) => count + 1)

        yield* deleteOld
      })

      const columns = sql`id, source, subject, occurred_at AS occurredAt, payload AS event`

      const list = Effect.fn("EventLog.list")(function* ({ limit, about, since }: EventFilter) {
        const rows = yield* unavailable(sql`
          SELECT ${columns} FROM event
          WHERE ${sql.and([
            ...(about === undefined
              ? []
              : [sql`source = ${about.source}`, sql.in("subject", about.subjects)]),
            ...(since === undefined ? [] : [sql`occurred_at >= ${DateTime.formatIso(since)}`]),
          ])}
          ORDER BY id DESC
          LIMIT ${limit + 1}
        `)

        const page = yield* readable(rows.slice(0, limit))

        return new EventPage({
          events: page.map(({ logged }) => logged),
          hasMore: rows.length > limit,
        })
      })

      return EventLog.of({
        record,
        list,
        latestId: unavailable(
          sql`SELECT MAX(id) AS latest FROM event`.pipe(
            Effect.flatMap(decodeLatest),
            Effect.map(([{ latest }]) => latest ?? 0),
          ),
        ),
        after: (cursors) =>
          cursors.length === 0
            ? Effect.succeed([])
            : unavailable(
                sql`
                  SELECT ${columns} FROM event
                  WHERE ${sql.or(
                    cursors.map(
                      ({ source, subject, after }) =>
                        sql`(source = ${source} AND subject = ${subject} AND id > ${after})`,
                    ),
                  )}
                  ORDER BY id
                `.pipe(Effect.flatMap(readable)),
              ),
        changes: SubscriptionRef.changes(recorded),
      })
    }),
  )
}

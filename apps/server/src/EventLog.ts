import { Event, EventLogError, EventPage, type EventSource, LoggedEvent } from "@glass/contracts"
import { Context, DateTime, Duration, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

export const KEPT_FOR = Duration.days(30)

const encodeEvent = Schema.encodeEffect(Event)

const decodeLogged = Schema.decodeUnknownEffect(
  Schema.Struct({ ...LoggedEvent.fields, event: Schema.fromJsonString(Event) }),
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

export class EventLog extends Context.Service<
  EventLog,
  {
    readonly record: (source: EventSource, events: ReadonlyArray<NewEvent>) => Effect.Effect<void>
    readonly list: (filter: EventFilter) => Effect.Effect<EventPage, EventLogError>
  }
>()("@glass/server/EventLog") {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const write = Effect.fnUntraced(
        function* (source: EventSource, { event, subject, once }: NewEvent, occurredAt: string) {
          yield* sql`INSERT OR IGNORE INTO event ${sql.insert({
            source,
            kind: event._tag,
            subject,
            once: once ?? null,
            payload: JSON.stringify(yield* encodeEvent(event)),
            occurred_at: occurredAt,
          })}`
        },
        Effect.catch((cause) => Effect.logWarning("Couldn't record an Event", cause)),
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

        yield* Effect.forEach(events, (event) => write(source, event, occurredAt), {
          discard: true,
        })
        yield* deleteOld
      })

      const list = Effect.fn("EventLog.list")(
        function* ({ limit, about, since }: EventFilter) {
          const rows = yield* sql`
            SELECT id, source, occurred_at AS occurredAt, payload AS event
            FROM event
            WHERE ${sql.and([
              ...(about === undefined
                ? []
                : [sql`source = ${about.source}`, sql.in("subject", about.subjects)]),
              ...(since === undefined ? [] : [sql`occurred_at >= ${DateTime.formatIso(since)}`]),
            ])}
            ORDER BY id DESC
            LIMIT ${limit + 1}
          `

          const logged = yield* Effect.forEach(rows.slice(0, limit), (row) =>
            decodeLogged(row).pipe(
              Effect.map((decoded) => Option.some(new LoggedEvent(decoded))),
              Effect.catch((cause) =>
                Effect.logWarning("Skipped an unreadable Event", cause).pipe(
                  Effect.as(Option.none()),
                ),
              ),
            ),
          )

          return new EventPage({
            events: logged.flatMap(Option.toArray),
            hasMore: rows.length > limit,
          })
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't read the Event log", cause)),
        Effect.mapError(
          () => new EventLogError({ message: "Couldn't load the Events. Try again." }),
        ),
      )

      return EventLog.of({ record, list })
    }),
  )
}

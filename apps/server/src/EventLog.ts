import {
  Event,
  EventLogError,
  EventPage,
  type EventSource,
  LoggedEvent,
  type PullRequestRef,
  referenceKey,
} from "@glass/contracts"
import { Context, DateTime, Duration, Effect, Layer, Option, Predicate, Schema } from "effect"
import { SqlClient } from "effect/sql"

export const KEPT_FOR = Duration.days(30)

const happensOnce = (event: Event) =>
  Predicate.isTagged(event, "PullRequestMerged") || Predicate.isTagged(event, "PullRequestClosed")

const encodeEvent = Schema.encodeEffect(Schema.fromJsonString(Event))

const decodeLogged = Schema.decodeUnknownEffect(
  Schema.Struct({ ...LoggedEvent.fields, event: Schema.fromJsonString(Event) }),
)

export interface EventFilter {
  readonly limit: number
  readonly pullRequests?: ReadonlyArray<PullRequestRef> | undefined
  readonly since?: DateTime.Utc | undefined
}

export class EventLog extends Context.Service<
  EventLog,
  {
    readonly record: (source: EventSource, events: ReadonlyArray<Event>) => Effect.Effect<void>
    readonly list: (filter: EventFilter) => Effect.Effect<EventPage, EventLogError>
  }
>()("@glass/server/EventLog") {
  static readonly layer = Layer.effect(
    EventLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient

      const write = Effect.fnUntraced(
        function* (source: EventSource, event: Event, occurredAt: string) {
          const payload = yield* encodeEvent(event)
          const pullRequest = referenceKey(event.pullRequest)

          yield* sql`
            INSERT INTO event (source, kind, pull_request, payload, occurred_at)
            SELECT ${source}, ${event._tag}, ${pullRequest}, ${payload}, ${occurredAt}
            WHERE ${
              happensOnce(event)
                ? sql`NOT EXISTS (
                    SELECT 1 FROM event
                    WHERE kind = ${event._tag} AND pull_request = ${pullRequest} AND payload = ${payload}
                  )`
                : sql.and([])
            }
          `
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
        events: ReadonlyArray<Event>,
      ) {
        if (events.length === 0) return

        const occurredAt = DateTime.formatIso(yield* DateTime.now)

        yield* Effect.forEach(events, (event) => write(source, event, occurredAt), {
          discard: true,
        })
        yield* deleteOld
      })

      const list = Effect.fn("EventLog.list")(
        function* ({ limit, pullRequests, since }: EventFilter) {
          const rows = yield* sql`
            SELECT id, source, occurred_at AS occurredAt, payload AS event
            FROM event
            WHERE ${sql.and([
              ...(pullRequests === undefined
                ? []
                : [sql.in("pull_request", pullRequests.map(referenceKey))]),
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

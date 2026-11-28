import {
  EventKind,
  EventSource,
  Subscription,
  SubscriptionSubject,
  subjectKey,
  subjectSource,
  ThreadError,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"
import { randomUUID } from "node:crypto"
import { EventLog } from "./EventLog"
import { Transcripts } from "./Transcripts"

export interface NewSubscription<E> {
  readonly subject: Effect.Effect<SubscriptionSubject, E>
  readonly kinds: ReadonlyArray<EventKind>
  readonly note: string
}

const KindsJson = Schema.fromJsonString(Schema.Array(EventKind))

const encodeKinds = Schema.encodeSync(KindsJson)

const SubjectJson = Schema.fromJsonString(SubscriptionSubject)

const encodeSubject = Schema.encodeSync(SubjectJson)

const StoredSubscription = Schema.Struct({
  id: Schema.String,
  subscriber: Schema.String,
  source: EventSource,
  subject: SubjectJson,
  subjectKey: Schema.String,
  kinds: KindsJson,
  note: Schema.String,
  deliveredThrough: Schema.Int,
  updatesInARow: Schema.Int,
  afterMessage: Schema.NullOr(Schema.String),
})

export type SubscriptionState = typeof StoredSubscription.Type

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredSubscription))

const decodeSaved = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ id: Schema.String })]))

const decodeSubscribers = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ subscriber: Schema.String })),
)

export interface AskedIn {
  readonly threadId: string
  readonly turnId: string | null
}

export const subscriptionOf = ({
  id,
  subscriber,
  source,
  subject,
  kinds,
  note,
}: SubscriptionState) => new Subscription({ id, subscriber, source, subject, kinds, note })

export interface Delivered {
  readonly subscriptionId: string
  readonly deliveredThrough: number
  readonly updatesInARow: number
  readonly afterMessage: string | null
  readonly ends: boolean
}

const sameSubscriptions = Schema.toEquivalence(Schema.Array(Subscription))

const storageFailure = (
  cause: SqlError.SqlError | Schema.SchemaError | { readonly _tag: "EventLogError" },
) =>
  Effect.logWarning("Couldn't read or save a Subscription", cause).pipe(
    Effect.andThen(
      Effect.fail(new ThreadError({ message: "Couldn't read or save the Subscription." })),
    ),
  )

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly subscribe: <E>(
      subscriber: string,
      askedIn: AskedIn,
      input: NewSubscription<E>,
    ) => Effect.Effect<Subscription, ThreadError | E>
    readonly list: (subscriber: string) => Effect.Effect<ReadonlyArray<Subscription>, ThreadError>
    readonly watch: (subscriber: string) => Stream.Stream<ReadonlyArray<Subscription>, ThreadError>
    readonly end: (
      subscriber: string,
      subscriptionId: string,
    ) => Effect.Effect<boolean, ThreadError>
    readonly changes: Stream.Stream<unknown>
    readonly subscribers: Effect.Effect<ReadonlyArray<string>, ThreadError>
    readonly states: (
      subscriber: string,
    ) => Effect.Effect<ReadonlyArray<SubscriptionState>, ThreadError>
    readonly about: (
      source: EventSource,
    ) => Effect.Effect<ReadonlyArray<SubscriptionState>, ThreadError>
    readonly deliver: (delivered: ReadonlyArray<Delivered>) => Effect.Effect<void, ThreadError>
  }
>()("@glass/server/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const eventLog = yield* EventLog
      const writes = yield* SubscriptionRef.make(0)

      const wrote = SubscriptionRef.update(writes, (count) => count + 1)

      const stored = (matching: Statement.Fragment) =>
        sql`
          SELECT id, subscriber, source, subject, subject_key AS subjectKey, kinds,
            note, delivered_through AS deliveredThrough, updates_in_a_row AS updatesInARow,
            after_message AS afterMessage
          FROM subscription WHERE ${matching} ORDER BY created_at, id
        `.pipe(Effect.flatMap(decodeStored), Effect.catch(storageFailure))

      const list = (subscriber: string) =>
        stored(sql`subscriber = ${subscriber}`).pipe(
          Effect.map((found) => found.map(subscriptionOf)),
        )

      const subscribe = Effect.fn("Subscriptions.subscribe")(function* <E>(
        subscriber: string,
        { threadId, turnId }: AskedIn,
        input: NewSubscription<E>,
      ) {
        if (!(yield* transcripts.startedByMessage(threadId, turnId)))
          return yield* new ThreadError({
            message:
              "Only a Turn a message started can subscribe. Glass started this one, or it began by itself.",
          })

        const subject = yield* input.subject
        const source = subjectSource(subject)
        const deliveredThrough = yield* eventLog.latestId.pipe(Effect.catch(storageFailure))

        const [{ id }] = yield* sql`
          INSERT INTO subscription ${sql.insert({
            id: randomUUID(),
            subscriber,
            source,
            subject: encodeSubject(subject),
            subject_key: subjectKey(subject),
            kinds: encodeKinds(input.kinds),
            note: input.note,
            delivered_through: deliveredThrough,
            created_at: DateTime.formatIso(yield* DateTime.now),
          })}
          ON CONFLICT (subscriber, source, subject_key)
          DO UPDATE SET kinds = excluded.kinds, note = excluded.note,
            delivered_through = excluded.delivered_through
          RETURNING id
        `.pipe(Effect.flatMap(decodeSaved), Effect.catch(storageFailure))

        yield* wrote

        return new Subscription({
          id,
          subscriber,
          source,
          subject,
          kinds: input.kinds,
          note: input.note,
        })
      })

      const end = Effect.fn("Subscriptions.end")(function* (
        subscriber: string,
        subscriptionId: string,
      ) {
        const ended = yield* sql`
          DELETE FROM subscription WHERE id = ${subscriptionId} AND subscriber = ${subscriber}
          RETURNING id
        `.pipe(Effect.catch(storageFailure))

        yield* wrote

        return ended.length > 0
      })

      const deliver = (delivered: ReadonlyArray<Delivered>) =>
        Effect.forEach(delivered, (one) =>
          one.ends
            ? sql`DELETE FROM subscription WHERE id = ${one.subscriptionId} RETURNING id`
            : sql`
                UPDATE subscription
                SET delivered_through = ${one.deliveredThrough},
                  updates_in_a_row = ${one.updatesInARow},
                  after_message = ${one.afterMessage}
                WHERE id = ${one.subscriptionId}
                RETURNING id
              `,
        ).pipe(
          Effect.catch(storageFailure),
          Effect.flatMap((rows) =>
            rows.every((row) => row.length > 0)
              ? Effect.void
              : Effect.fail(
                  new ThreadError({ message: "A Subscription ended before it was told." }),
                ),
          ),
          Effect.andThen(delivered.length > 0 ? wrote : Effect.void),
        )

      return Subscriptions.of({
        subscribe,
        list,
        end,
        deliver,
        watch: (subscriber) =>
          SubscriptionRef.changes(writes).pipe(
            Stream.mapEffect(() => list(subscriber)),
            Stream.changesWith(sameSubscriptions),
          ),
        changes: SubscriptionRef.changes(writes),
        subscribers: sql`
          SELECT subscriber FROM subscription
          GROUP BY subscriber ORDER BY MIN(created_at), MIN(rowid)
        `.pipe(
          Effect.flatMap(decodeSubscribers),
          Effect.map((found) => found.map(({ subscriber }) => subscriber)),
          Effect.catch(storageFailure),
        ),
        states: (subscriber) => stored(sql`subscriber = ${subscriber}`),
        about: (source) => stored(sql`source = ${source}`),
      })
    }),
  )
}

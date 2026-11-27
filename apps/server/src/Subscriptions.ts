import {
  type EventSource,
  Subscription,
  SubscriptionEnding,
  SubscriptionReason,
  SubscriptionSubject,
  ThreadError,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"
import { randomUUID } from "node:crypto"
import { isOnTheUsersWord } from "./threadState"
import { Transcripts } from "./Transcripts"
import { LastTold, type Told } from "./updateDecision"

export interface NewSubscription<E> {
  readonly source: EventSource
  readonly subject: Effect.Effect<SubscriptionSubject, E>
  readonly reasons: ReadonlyArray<SubscriptionReason>
  readonly note: string
}

const ReasonsJson = Schema.fromJsonString(Schema.Array(SubscriptionReason))

const encodeReasons = Schema.encodeSync(ReasonsJson)

const SubjectJson = Schema.fromJsonString(SubscriptionSubject)

const encodeSubject = Schema.encodeSync(SubjectJson)

const encodeTold = Schema.encodeSync(Schema.fromJsonString(LastTold))

const encodeEnding = Schema.encodeSync(Schema.fromJsonString(SubscriptionEnding))

const StoredSubscription = Schema.Struct({
  ...Subscription.fields,
  subject: SubjectJson,
  reasons: ReasonsJson,
  lastTold: Schema.NullOr(Schema.fromJsonString(LastTold)),
  ended: Schema.NullOr(Schema.fromJsonString(SubscriptionEnding)),
})

type StoredSubscription = typeof StoredSubscription.Type

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredSubscription))

const decodeSaved = Schema.decodeUnknownEffect(Schema.Tuple([Schema.Struct({ id: Schema.String })]))

const decodeThreadIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: Schema.String })),
)

const subscriptionOf = ({ id, threadId, source, subject, reasons, note }: StoredSubscription) =>
  new Subscription({ id, threadId, source, subject, reasons, note })

export interface SubscriptionState {
  readonly subscription: Subscription
  readonly lastTold: LastTold | null
  readonly ended: SubscriptionEnding | null
}

export interface ToldSubscription {
  readonly subscriptionId: string
  readonly subject: string
  readonly told: Told
  readonly ends: boolean
}

const stateOf = (stored: StoredSubscription): SubscriptionState => ({
  subscription: subscriptionOf(stored),
  lastTold: stored.lastTold,
  ended: stored.ended,
})

const refusedStarters = {
  glass: "Glass started this Turn",
  harness: "The agent started this Turn by itself",
  agent: "A message from another agent started this Turn",
  none: "Glass has no record of the Turn asking",
}

const sameSubscriptions = Schema.toEquivalence(Schema.Array(Subscription))

const storageFailure = (cause: SqlError.SqlError | Schema.SchemaError) =>
  Effect.logWarning("Couldn't read or save a Subscription", cause).pipe(
    Effect.andThen(
      Effect.fail(new ThreadError({ message: "Couldn't read or save the Subscription." })),
    ),
  )

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly subscribe: <E>(
      threadId: string,
      turnId: string | null,
      input: NewSubscription<E>,
    ) => Effect.Effect<Subscription, ThreadError | E>
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<Subscription>, ThreadError>
    readonly watch: (threadId: string) => Stream.Stream<ReadonlyArray<Subscription>, ThreadError>
    readonly end: (threadId: string, subscriptionId: string) => Effect.Effect<boolean, ThreadError>
    readonly changes: Stream.Stream<unknown>
    readonly subscribedThreads: Effect.Effect<ReadonlyArray<string>, ThreadError>
    readonly states: (
      threadId: string,
      source: EventSource,
    ) => Effect.Effect<ReadonlyArray<SubscriptionState>, ThreadError>
    readonly notEnded: (
      source: EventSource,
    ) => Effect.Effect<ReadonlyArray<Subscription>, ThreadError>
    readonly endAbout: (
      subscriptions: ReadonlyArray<Subscription>,
      ended: SubscriptionEnding,
      toldBy: SubscriptionReason,
    ) => Effect.Effect<void, ThreadError>
    readonly recordTold: (
      told: ReadonlyArray<ToldSubscription>,
      lastMessageTurn: string | null,
    ) => Effect.Effect<void, ThreadError>
  }
>()("@glass/server/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const transcripts = yield* Transcripts
      const writes = yield* SubscriptionRef.make(0)

      const wrote = SubscriptionRef.update(writes, (count) => count + 1)

      const stored = (matching: Statement.Fragment) =>
        sql`
          SELECT id, thread_id AS threadId, source, subject, reasons, note,
            last_told AS lastTold, ended
          FROM subscription WHERE ${matching} ORDER BY created_at, id
        `.pipe(Effect.flatMap(decodeStored), Effect.catch(storageFailure))

      const list = (threadId: string) =>
        stored(sql`thread_id = ${threadId}`).pipe(Effect.map((found) => found.map(subscriptionOf)))

      const subscribe = Effect.fn("Subscriptions.subscribe")(function* <E>(
        threadId: string,
        turnId: string | null,
        input: NewSubscription<E>,
      ) {
        const starter = yield* transcripts.turnStarter(threadId, turnId)

        if (!isOnTheUsersWord(starter))
          return yield* new ThreadError({
            message: `${refusedStarters[starter ?? "none"]}, so it can't subscribe your Thread. Only a Turn started by the user's message, or by a message from the Thread or Global chat that created your Thread, can.`,
          })

        const subject = yield* input.subject

        const [{ id }] = yield* sql`
          INSERT INTO subscription ${sql.insert({
            id: randomUUID(),
            thread_id: threadId,
            source: input.source,
            subject: encodeSubject(subject),
            reasons: encodeReasons(input.reasons),
            note: input.note,
            created_at: DateTime.formatIso(yield* DateTime.now),
          })}
          ON CONFLICT (thread_id, source, subject) WHERE ended IS NULL
          DO UPDATE SET reasons = excluded.reasons, note = excluded.note
          RETURNING id
        `.pipe(Effect.flatMap(decodeSaved), Effect.catch(storageFailure))

        yield* wrote

        return new Subscription({
          id,
          threadId,
          source: input.source,
          subject,
          reasons: input.reasons,
          note: input.note,
        })
      })

      const end = Effect.fn("Subscriptions.end")(function* (
        threadId: string,
        subscriptionId: string,
      ) {
        const ended = yield* sql`
          DELETE FROM subscription WHERE id = ${subscriptionId} AND thread_id = ${threadId}
          RETURNING id
        `.pipe(Effect.catch(storageFailure))

        yield* wrote

        return ended.length > 0
      })

      const endAbout = Effect.fnUntraced(function* (
        subscriptions: ReadonlyArray<Subscription>,
        ended: SubscriptionEnding,
        toldBy: SubscriptionReason,
      ) {
        yield* Effect.forEach(
          subscriptions,
          ({ id, reasons }) =>
            reasons.includes(toldBy)
              ? sql`UPDATE subscription SET ended = ${encodeEnding(ended)} WHERE id = ${id}`
              : sql`DELETE FROM subscription WHERE id = ${id}`,
          { discard: true },
        ).pipe(Effect.catch(storageFailure))

        if (subscriptions.length > 0) yield* wrote
      })

      return Subscriptions.of({
        subscribe,
        list,
        end,
        watch: (threadId) =>
          SubscriptionRef.changes(writes).pipe(
            Stream.mapEffect(() => list(threadId)),
            Stream.changesWith(sameSubscriptions),
          ),
        changes: SubscriptionRef.changes(writes),
        subscribedThreads: sql`
          SELECT thread_id AS threadId FROM subscription
          GROUP BY thread_id ORDER BY MIN(created_at), MIN(rowid)
        `.pipe(
          Effect.flatMap(decodeThreadIds),
          Effect.map((found) => found.map(({ threadId }) => threadId)),
          Effect.catch(storageFailure),
        ),
        states: (threadId, source) =>
          stored(sql`thread_id = ${threadId} AND source = ${source}`).pipe(
            Effect.map((found) => found.map(stateOf)),
          ),
        notEnded: (source) =>
          stored(sql`source = ${source} AND ended IS NULL`).pipe(
            Effect.map((found) => found.map(subscriptionOf)),
          ),
        endAbout,
        recordTold: (told, lastMessageTurn) =>
          Effect.forEach(told, ({ subscriptionId, subject, told: state, ends }) =>
            ends
              ? sql`DELETE FROM subscription WHERE id = ${subscriptionId} RETURNING id`
              : sql`
                  UPDATE subscription
                  SET last_told = ${encodeTold({ subject, told: state, afterMessage: lastMessageTurn })}
                  WHERE id = ${subscriptionId}
                  RETURNING id
                `,
          ).pipe(
            Effect.catch(storageFailure),
            Effect.flatMap((recorded) =>
              recorded.every((rows) => rows.length > 0)
                ? Effect.void
                : Effect.fail(
                    new ThreadError({ message: "A Subscription ended before it was told." }),
                  ),
            ),
            Effect.andThen(told.length > 0 ? wrote : Effect.void),
          ),
      })
    }),
  )
}

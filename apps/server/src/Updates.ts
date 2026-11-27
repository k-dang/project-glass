import { ThreadError, Update, type UpdatedSubscription } from "@glass/contracts"
import { Array as Arr, DateTime, Effect, Exit, Layer, Ref, Stream } from "effect"
import { EventLog } from "./EventLog"
import { SettingsStore } from "./SettingsStore"
import { Subscriptions, type SubscriptionState } from "./Subscriptions"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"
import { delivered, type Pending, pendingFor, tells } from "./updateDelivery"
import { recordUnit } from "./wideEvents"

const RUN_AT_ONCE = 3

export const changed = (changes: ReadonlyArray<Stream.Stream<unknown, unknown>>) =>
  Stream.mergeAll(
    changes.map((change) =>
      change.pipe(
        Stream.catch((cause) =>
          Stream.fromEffect(Effect.logWarning("Stopped following a change Updates follow", cause)),
        ),
        Stream.as(undefined),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))

export const pendingOf = Effect.fnUntraced(function* (
  eventLog: EventLog["Service"],
  states: ReadonlyArray<SubscriptionState>,
  lastMessageTurn: string | null,
) {
  const events = yield* eventLog
    .after(
      states.map(({ source, subjectKey, deliveredThrough }) => ({
        source,
        subject: subjectKey,
        after: deliveredThrough,
      })),
    )
    .pipe(Effect.mapError(({ message }) => new ThreadError({ message })))

  return states.map((state) => pendingFor(state, events, lastMessageTurn))
})

const updated = ({ state, events }: Pending): ReadonlyArray<UpdatedSubscription> =>
  Arr.isReadonlyArrayNonEmpty(events)
    ? [{ subscriptionId: state.id, subject: state.subject, note: state.note, events }]
    : []

const asUnitOfWork = <E, R>(
  threadId: string,
  told: ReadonlyArray<Pending>,
  send: (started: (turnId: string) => Effect.Effect<void>) => Effect.Effect<unknown, E, R>,
) =>
  Effect.gen(function* () {
    const startedAt = yield* DateTime.now
    const turn = yield* Ref.make<string | undefined>(undefined)

    yield* send((turnId) => Ref.set(turn, turnId)).pipe(
      Effect.onExit(
        Effect.fnUntraced(function* (exit) {
          const turnId = yield* Ref.get(turn)

          if (turnId === undefined && Exit.isSuccess(exit)) return

          yield* recordUnit("Update", {
            startedAt,
            endedAt: yield* DateTime.now,
            exit,
            fields: {
              thread_id: threadId,
              turn_id: turnId,
              subjects: told.map(({ state }) => state.subjectKey).join(),
              subscription_ids: told.map(({ state }) => state.id).join(),
              kinds: Arr.dedupe(
                told.flatMap(({ events }) => events.map(({ event }) => event._tag)),
              ).join(),
            },
          })
        }),
      ),
    )
  })

export const Updates = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Threads
    const subscriptions = yield* Subscriptions
    const transcripts = yield* Transcripts
    const eventLog = yield* EventLog
    const settings = yield* SettingsStore

    const noteOf = settings.read().pipe(
      Effect.map(({ pullRequestUpdateNote }) => pullRequestUpdateNote),
      Effect.mapError(({ message }) => new ThreadError({ message })),
    )

    const sendUpdate = (threadId: string, waits: Effect.Effect<void>) =>
      threads.whenIdle(threadId, (start) =>
        Effect.gen(function* () {
          const lastMessageTurn = yield* transcripts.lastMessageTurn(threadId)

          const pending = yield* pendingOf(
            eventLog,
            yield* subscriptions.states(threadId),
            lastMessageTurn,
          )

          const record = (which: ReadonlyArray<Pending>) =>
            which.flatMap((one) => delivered(one, lastMessageTurn) ?? [])

          const told = pending.filter(tells)
          const quiet = pending.filter((one) => !tells(one))
          const updates = told.flatMap(updated)

          if (!Arr.isReadonlyArrayNonEmpty(updates))
            return yield* subscriptions.deliver(record(quiet))

          if ((yield* transcripts.runningUpdates).length >= RUN_AT_ONCE) {
            yield* subscriptions.deliver(record(quiet))

            return yield* waits
          }

          const context = Update.make({ subscriptions: updates, note: yield* noteOf })

          return yield* asUnitOfWork(threadId, told, (started) =>
            start({ message: "", images: [], context, retriesDelivery: false }, (turnId) =>
              subscriptions.deliver(record(pending)).pipe(Effect.andThen(started(turnId))),
            ),
          )
        }),
      )

    const waiting = yield* Ref.make<ReadonlyArray<string>>([])

    const sendUpdates = Effect.gen(function* () {
      const subscribed = yield* subscriptions.subscribedThreads
      const inLine = (yield* Ref.get(waiting)).filter((threadId) => subscribed.includes(threadId))
      const next = yield* Ref.make<ReadonlyArray<string>>([])

      yield* Effect.forEach(
        [...inLine, ...subscribed.filter((threadId) => !inLine.includes(threadId))],
        (threadId) =>
          sendUpdate(threadId, Ref.update(next, Arr.append(threadId))).pipe(
            Effect.catch((cause) => Effect.logWarning("Couldn't send an Update", cause)),
          ),
        { discard: true },
      )

      yield* Ref.set(waiting, yield* Ref.get(next))
    }).pipe(
      Effect.catch((cause: ThreadError) =>
        Effect.logWarning("Couldn't read the Subscriptions", cause),
      ),
    )

    yield* changed([
      subscriptions.changes,
      eventLog.changes,
      yield* transcripts.subscribeMaybeIdle,
    ]).pipe(
      Stream.runForEach(() => sendUpdates),
      Effect.forkScoped,
    )
  }),
)

import type { EventSource, ThreadError } from "@glass/contracts"
import { Array as Arr, DateTime, Effect, Exit, Layer, Ref, Stream } from "effect"
import { changed, Sources, type SubscriptionDecision } from "./Source"
import { Subscriptions, type ToldSubscription } from "./Subscriptions"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"
import { sameTold } from "./updateDecision"
import { recordUnit } from "./wideEvents"

const RUN_AT_ONCE = 3

const tells = ({ due }: SubscriptionDecision) => due.length > 0

const toRecord = (decisions: ReadonlyArray<SubscriptionDecision>) =>
  decisions.flatMap((decided): ReadonlyArray<ToldSubscription> => {
    const { state, subject, before, told } = decided
    const ends = state.ended !== null && tells(decided)

    return ends || !sameTold(told, before)
      ? [{ subscriptionId: state.subscription.id, subject, told, ends }]
      : []
  })

const untold = (decisions: ReadonlyArray<SubscriptionDecision>) =>
  decisions.filter((decided) => !tells(decided))

const asUnitOfWork = <E, R>(
  threadId: string,
  source: EventSource,
  told: ReadonlyArray<SubscriptionDecision>,
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
              source,
              subjects: told.map(({ subject }) => subject).join(),
              subscription_ids: told.map(({ state }) => state.subscription.id).join(),
              reasons: Arr.dedupe(told.flatMap(({ due }) => due)).join(),
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
    const sources = yield* Sources

    const sendUpdate = (threadId: string, waits: Effect.Effect<void>) =>
      threads.whenIdle(threadId, (start) =>
        Effect.gen(function* () {
          const lastMessageTurn = yield* transcripts.lastMessageTurn(threadId)

          for (const source of sources) {
            const { decisions, update } = yield* source.decide(
              threadId,
              yield* subscriptions.states(threadId, source.name),
              lastMessageTurn,
            )

            if (update === undefined) {
              yield* subscriptions.recordTold(toRecord(decisions), lastMessageTurn)

              continue
            }

            if ((yield* transcripts.runningUpdates).length >= RUN_AT_ONCE) {
              yield* subscriptions.recordTold(toRecord(untold(decisions)), lastMessageTurn)
              yield* waits

              return
            }

            const context = yield* update
            const record = toRecord(decisions)

            yield* asUnitOfWork(threadId, source.name, decisions.filter(tells), (started) =>
              start({ message: "", images: [], context, retriesDelivery: false }, (turnId) =>
                subscriptions
                  .recordTold(record, lastMessageTurn)
                  .pipe(Effect.andThen(started(turnId))),
              ),
            )

            return
          }
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
      ...sources.flatMap(({ changes }) => changes),
      yield* transcripts.subscribeMaybeIdle,
    ]).pipe(
      Stream.runForEach(() => sendUpdates),
      Effect.forkScoped,
    )
  }),
)

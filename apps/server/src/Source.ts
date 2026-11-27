import type { EventSource, SubscriptionReason, ThreadError, Update } from "@glass/contracts"
import { Array as Arr, Context, Effect, Stream } from "effect"
import type { SubscriptionState } from "./Subscriptions"
import { decide, type SubjectNow, type Told, toldBefore } from "./updateDecision"

export interface Subscribed<Detail> {
  readonly state: SubscriptionState
  readonly subject: string
  readonly now: SubjectNow<Detail>
}

export const decided = <Detail, Extra>(
  subscribed: ReadonlyArray<Subscribed<Detail> & Extra>,
  lastMessageTurn: string | null,
) =>
  subscribed.map((one) => {
    const before = toldBefore(one.state.lastTold, one.subject, lastMessageTurn)

    return { ...one, before, decision: decide(one.state.subscription.reasons, one.now, before) }
  })

export interface SubscriptionDecision {
  readonly state: SubscriptionState
  readonly subject: string
  readonly before: Told
  readonly told: Told
  readonly due: ReadonlyArray<SubscriptionReason>
}

export interface Decided {
  readonly decisions: ReadonlyArray<SubscriptionDecision>
  readonly update: Effect.Effect<Update, ThreadError> | undefined
}

export interface Source {
  readonly name: EventSource
  readonly changes: ReadonlyArray<Stream.Stream<unknown, unknown>>
  readonly decide: (
    threadId: string,
    states: ReadonlyArray<SubscriptionState>,
    lastMessageTurn: string | null,
  ) => Effect.Effect<Decided, ThreadError>
}

export const sourceOf = <Detail, Extra>(source: {
  readonly name: EventSource
  readonly changes: ReadonlyArray<Stream.Stream<unknown, unknown>>
  readonly now: (
    threadId: string,
    states: ReadonlyArray<SubscriptionState>,
  ) => Effect.Effect<ReadonlyArray<Subscribed<Detail> & Extra>, ThreadError>
  readonly update: (
    due: Arr.NonEmptyReadonlyArray<
      NoInfer<Subscribed<Detail> & Extra> & {
        readonly reasons: Arr.NonEmptyReadonlyArray<NoInfer<Detail>>
      }
    >,
  ) => Effect.Effect<Update, ThreadError>
}): Source => ({
  name: source.name,
  changes: source.changes,
  decide: (threadId, states, lastMessageTurn) =>
    source.now(threadId, states).pipe(
      Effect.map((subscribed) => {
        const all = decided(subscribed, lastMessageTurn)

        const due = all.flatMap((one) => {
          const reasons = one.decision.due.map(({ detail }) => detail)

          return Arr.isReadonlyArrayNonEmpty(reasons) ? [{ ...one, reasons }] : []
        })

        return {
          decisions: all.map(({ state, subject, before, decision }) => ({
            state,
            subject,
            before,
            told: decision.told,
            due: decision.due.map(({ reason }) => reason),
          })),
          update: Arr.isReadonlyArrayNonEmpty(due) ? source.update(due) : undefined,
        }
      }),
    ),
})

export class Sources extends Context.Service<Sources, ReadonlyArray<Source>>()(
  "@glass/server/Sources",
) {}

export const changed = (changes: ReadonlyArray<Stream.Stream<unknown, unknown>>) =>
  Stream.mergeAll(
    changes.map((change) =>
      change.pipe(
        Stream.catch((cause) =>
          Stream.fromEffect(
            Effect.logWarning("Stopped following a change Updates are decided from", cause),
          ),
        ),
        Stream.as(undefined),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))

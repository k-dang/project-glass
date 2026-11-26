import {
  type EventSource,
  type SubscriptionReason,
  subscriptionReasonOf,
  type ThreadError,
  type TurnContext,
  type Update,
} from "@glass/contracts"
import { Context, type DateTime, Effect, Predicate, Stream } from "effect"
import type { SubscriptionState } from "./Subscriptions"
import type { Standing, Told } from "./updateDecision"

export interface SubscriptionDecision {
  readonly state: SubscriptionState
  readonly subject: string
  readonly before: Told
  readonly told: Told
  readonly due: ReadonlyArray<SubscriptionReason>
  readonly standing: Readonly<Partial<Record<SubscriptionReason, Standing>>>
}

export interface Telling {
  readonly subscriptionId: string
  readonly reasons: ReadonlyArray<SubscriptionReason>
}

export const telling = (context: TurnContext | null): ReadonlyArray<Telling> | undefined =>
  Predicate.isTagged(context, "Update")
    ? context.subjects.map(({ subscriptionId, reasons }) => ({
        subscriptionId,
        reasons: reasons.map(({ _tag }) => subscriptionReasonOf[_tag]),
      }))
    : undefined

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
    readSince?: DateTime.Utc,
  ) => Effect.Effect<Decided, ThreadError>
}

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

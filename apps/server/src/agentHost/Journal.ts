import { Context, Effect, Layer, Predicate, PubSub, Stream, SubscriptionRef } from "effect"
import { randomUUID } from "node:crypto"
import {
  type HostEvent,
  HostReplaced,
  type JournalEntry,
  type UnacknowledgedTurn,
} from "./protocol"

interface Attendance {
  readonly followers: number
  readonly unacknowledged: number
}

export const JournalBudget = Context.Reference<number>("@glass/server/agentHost/JournalBudget", {
  defaultValue: () => 64 * 1024 * 1024,
})

const keptAfter = (kept: ReadonlyArray<{ readonly entry: JournalEntry }>, sequence: number) => {
  const index = kept.findIndex(({ entry }) => entry.sequence > sequence)

  return index === -1 ? kept.length : index
}

export class Journal extends Context.Service<
  Journal,
  {
    readonly host: string
    readonly append: (conversationId: string, event: HostEvent) => Effect.Effect<boolean>
    readonly watch: (host: string, after: number) => Stream.Stream<JournalEntry, HostReplaced>
    readonly acknowledge: (host: string, through: number) => Effect.Effect<void>
    readonly attendance: SubscriptionRef.SubscriptionRef<Attendance>
    readonly unacknowledgedEnds: Effect.Effect<ReadonlyArray<UnacknowledgedTurn>>
  }
>()("@glass/server/agentHost/Journal") {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const budget = yield* JournalBudget
      const host = randomUUID()
      const published = yield* PubSub.unbounded<JournalEntry>()
      const kept: Array<{ readonly entry: JournalEntry; readonly chars: number }> = []
      let keptChars = 0
      let sequence = 0

      const attendance = yield* SubscriptionRef.make<Attendance>({
        followers: 0,
        unacknowledged: 0,
      })

      const countKept = SubscriptionRef.update(attendance, (before) => ({
        ...before,
        unacknowledged: kept.length,
      }))

      const follow = (change: number) =>
        SubscriptionRef.update(attendance, (before) => ({
          ...before,
          followers: before.followers + change,
        }))

      return Journal.of({
        host,
        append: (conversationId, event) =>
          Effect.suspend(() => {
            const entry = { sequence: ++sequence, conversationId, event }
            const chars = JSON.stringify(event).length
            kept.push({ entry, chars })
            keptChars += chars

            return countKept.pipe(
              Effect.andThen(PubSub.publish(published, entry)),
              Effect.as(keptChars > budget),
            )
          }),
        watch: (watched, after) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (watched !== host) return yield* new HostReplaced()

              const live = yield* PubSub.subscribe(published)

              const missed = kept.slice(keptAfter(kept, after)).map(({ entry }) => entry)

              const last = missed.at(-1)?.sequence ?? after

              yield* Effect.acquireRelease(follow(1), () => follow(-1))

              return Stream.concat(
                Stream.fromIterable(missed),
                Stream.fromSubscription(live).pipe(Stream.filter((entry) => entry.sequence > last)),
              )
            }),
          ),
        acknowledge: (acknowledged, through) =>
          Effect.suspend(() => {
            if (acknowledged !== host) return Effect.void
            const dropped = kept.splice(0, keptAfter(kept, through))
            keptChars -= dropped.reduce((total, { chars }) => total + chars, 0)

            return countKept
          }),
        attendance,
        unacknowledgedEnds: Effect.sync(() =>
          kept.flatMap(({ entry: { conversationId, event } }) =>
            Predicate.isTagged(event, "TurnEnded")
              ? [{ conversationId, turnId: event.turnId }]
              : [],
          ),
        ),
      })
    }),
  )
}

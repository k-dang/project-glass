import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { HostEvent, JournalEntry } from "./protocol"

/** JSON characters of unacknowledged output kept for Glass while it is away: many Agent-hours. */
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
    /** Keeps every entry, and says whether the unacknowledged ones are now over the budget. */
    readonly append: (conversationId: string, event: HostEvent) => Effect.Effect<boolean>
    readonly watch: (after: number) => Stream.Stream<JournalEntry>
    readonly acknowledge: (through: number) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/Journal") {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const budget = yield* JournalBudget
      const published = yield* PubSub.unbounded<JournalEntry>()
      const kept: Array<{ readonly entry: JournalEntry; readonly chars: number }> = []
      let keptChars = 0
      let sequence = 0

      return Journal.of({
        append: (conversationId, event) =>
          Effect.suspend(() => {
            const entry = { sequence: ++sequence, conversationId, event }
            const chars = JSON.stringify(event).length
            kept.push({ entry, chars })
            keptChars += chars

            return PubSub.publish(published, entry).pipe(Effect.as(keptChars > budget))
          }),
        watch: (after) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const live = yield* PubSub.subscribe(published)

              const missed = kept.slice(keptAfter(kept, after)).map(({ entry }) => entry)

              const last = missed.at(-1)?.sequence ?? after

              return Stream.concat(
                Stream.fromIterable(missed),
                Stream.fromSubscription(live).pipe(Stream.filter((entry) => entry.sequence > last)),
              )
            }),
          ),
        acknowledge: (through) =>
          Effect.sync(() => {
            const acknowledged = kept.splice(0, keptAfter(kept, through))
            keptChars -= acknowledged.reduce((total, { chars }) => total + chars, 0)
          }),
      })
    }),
  )
}

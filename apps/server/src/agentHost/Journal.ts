import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { HostEvent, JournalEntry } from "./protocol"

/**
 * How much unacknowledged output, counted as JSON, the host keeps for Glass while it is away.
 * `pnpm measure:journal` puts an Agent working without pause at about 4 MB an hour, so this holds
 * about 17 Agent-hours in about 120 MB of heap. Past it, HostAgents stops the Turn that wrote.
 */
export const JournalBudget = Context.Reference<number>("@glass/server/agentHost/JournalBudget", {
  defaultValue: () => 64 * 1024 * 1024,
})

export class Journal extends Context.Service<
  Journal,
  {
    readonly append: (agentId: string, event: HostEvent) => Effect.Effect<void>
    readonly watch: (after: number) => Stream.Stream<JournalEntry>
    readonly acknowledge: (through: number) => Effect.Effect<void>
    /** Whether the unacknowledged entries are over the budget. It never drops any. */
    readonly full: Effect.Effect<boolean>
  }
>()("@glass/server/agentHost/Journal") {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const budget = yield* JournalBudget
      const published = yield* PubSub.unbounded<JournalEntry>()
      let kept: Array<{ readonly entry: JournalEntry; readonly bytes: number }> = []
      let keptBytes = 0
      let sequence = 0

      return Journal.of({
        append: (agentId, event) =>
          Effect.suspend(() => {
            const entry = { sequence: ++sequence, agentId, event }
            const bytes = JSON.stringify(event).length
            kept.push({ entry, bytes })
            keptBytes += bytes

            return PubSub.publish(published, entry)
          }),
        watch: (after) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const live = yield* PubSub.subscribe(published)

              const missed = kept.flatMap(({ entry }) => (entry.sequence > after ? [entry] : []))

              const last = missed.at(-1)?.sequence ?? after

              return Stream.concat(
                Stream.fromIterable(missed),
                Stream.fromSubscription(live).pipe(Stream.filter((entry) => entry.sequence > last)),
              )
            }),
          ),
        acknowledge: (through) =>
          Effect.sync(() => {
            kept = kept.filter(({ entry, bytes }) => {
              if (entry.sequence > through) return true
              keptBytes -= bytes

              return false
            })
          }),
        full: Effect.sync(() => keptBytes > budget),
      })
    }),
  )
}

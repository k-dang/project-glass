import type { AgentEvent } from "@glass/contracts"
import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { JournalEntry } from "./protocol"

export class Journal extends Context.Service<
  Journal,
  {
    readonly append: (agentId: string, event: AgentEvent) => Effect.Effect<void>
    readonly watch: (after: number) => Stream.Stream<JournalEntry>
    readonly acknowledge: (through: number) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/Journal") {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const published = yield* PubSub.unbounded<JournalEntry>()
      let kept: Array<JournalEntry> = []
      let sequence = 0

      return Journal.of({
        append: (agentId, event) =>
          Effect.suspend(() => {
            const entry = { sequence: ++sequence, agentId, event }
            kept.push(entry)

            return PubSub.publish(published, entry)
          }),
        watch: (after) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const live = yield* PubSub.subscribe(published)
              const missed = kept.filter((entry) => entry.sequence > after)
              const last = missed.at(-1)?.sequence ?? after

              return Stream.concat(
                Stream.fromIterable(missed),
                Stream.fromSubscription(live).pipe(Stream.filter((entry) => entry.sequence > last)),
              )
            }),
          ),
        acknowledge: (through) =>
          Effect.sync(() => {
            kept = kept.filter((entry) => entry.sequence > through)
          }),
      })
    }),
  )
}

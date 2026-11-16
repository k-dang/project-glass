import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { randomUUID } from "node:crypto"
import { type HostEvent, HostReplaced, type JournalEntry } from "./protocol"

export class Journal extends Context.Service<
  Journal,
  {
    readonly host: string
    readonly append: (conversationId: string, event: HostEvent) => Effect.Effect<void>
    readonly watch: (host: string, after: number) => Stream.Stream<JournalEntry, HostReplaced>
    readonly acknowledge: (host: string, through: number) => Effect.Effect<void>
  }
>()("@glass/server/agentHost/Journal") {
  static readonly layer = Layer.effect(
    Journal,
    Effect.gen(function* () {
      const host = randomUUID()
      const published = yield* PubSub.unbounded<JournalEntry>()
      let kept: Array<JournalEntry> = []
      let sequence = 0

      return Journal.of({
        host,
        append: (conversationId, event) =>
          Effect.suspend(() => {
            const entry = { sequence: ++sequence, conversationId, event }
            kept.push(entry)

            return PubSub.publish(published, entry)
          }),
        watch: (watched, after) =>
          Stream.unwrap(
            Effect.gen(function* () {
              if (watched !== host) return yield* new HostReplaced()

              const live = yield* PubSub.subscribe(published)
              const missed = kept.filter((entry) => entry.sequence > after)
              const last = missed.at(-1)?.sequence ?? after

              return Stream.concat(
                Stream.fromIterable(missed),
                Stream.fromSubscription(live).pipe(Stream.filter((entry) => entry.sequence > last)),
              )
            }),
          ),
        acknowledge: (acknowledged, through) =>
          Effect.sync(() => {
            if (acknowledged === host) kept = kept.filter((entry) => entry.sequence > through)
          }),
      })
    }),
  )
}

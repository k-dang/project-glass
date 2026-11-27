import { type EventKind, isGone, type PullRequestRef, type Thread } from "@glass/contracts"
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect"
import { EventLog } from "./EventLog"
import { Subscriptions } from "./Subscriptions"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"
import { tells } from "./updateDelivery"
import { changed, pendingOf } from "./Updates"

export interface PullRequestStanding {
  readonly pullRequest: PullRequestRef
  readonly kinds: ReadonlyArray<EventKind>
  readonly thread: Thread
  readonly state: "handling" | "tried"
}

export class PullRequestStandings extends Context.Service<
  PullRequestStandings,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<PullRequestStanding>>
  }
>()("@glass/server/PullRequestStandings") {
  static readonly layer = Layer.effect(
    PullRequestStandings,
    Effect.gen(function* () {
      const threads = yield* Threads
      const subscriptions = yield* Subscriptions
      const transcripts = yield* Transcripts
      const eventLog = yield* EventLog

      const standingsOf = Effect.fnUntraced(function* (
        thread: Thread,
        beingTold: ReadonlySet<string>,
      ) {
        const pending = yield* pendingOf(
          eventLog,
          yield* subscriptions.states(thread.id),
          yield* transcripts.lastMessageTurn(thread.id),
        )

        return pending.map((one): PullRequestStanding => ({
          pullRequest: one.state.subject.pullRequest,
          kinds: one.state.kinds,
          thread,
          state:
            beingTold.has(one.state.id) || tells(one) || one.updatesInARow === 0
              ? "handling"
              : "tried",
        }))
      })

      const standings = Effect.gen(function* () {
        const listed = Option.getOrElse(
          yield* threads.watch().pipe(Stream.runHead),
          (): ReadonlyArray<Thread> => [],
        )

        const beingTold = new Set(
          (yield* transcripts.runningUpdates).flatMap(({ update }) =>
            update.subscriptions.map(({ subscriptionId }) => subscriptionId),
          ),
        )

        return yield* Effect.forEach(yield* subscriptions.subscribedThreads, (threadId) => {
          const thread = listed.find(({ id }) => id === threadId)

          return thread === undefined || (thread.sandbox !== null && isGone(thread.sandbox.reach))
            ? Effect.succeed([])
            : standingsOf(thread, beingTold)
        }).pipe(Effect.map(Arr.flatten))
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read what subscribed Threads are doing", cause).pipe(
            Effect.as<ReadonlyArray<PullRequestStanding>>([]),
          ),
        ),
      )

      return PullRequestStandings.of({
        watch: () =>
          changed([
            subscriptions.changes,
            eventLog.changes,
            threads.watch(),
            threads.keptGoing,
            transcripts.running,
          ]).pipe(Stream.mapEffect(() => standings)),
      })
    }),
  )
}

import {
  isGone,
  type OpenReason,
  openReasons,
  type PullRequestRef,
  type PullRequestUpdate,
  subscriptionReasonOf,
  type Thread,
} from "@glass/contracts"
import { Array as Arr, Context, Effect, Layer, Option, Stream } from "effect"
import { PullRequestMirror } from "./PullRequestMirror"
import { changed, subscriptionDecisions } from "./subscriptionDecisions"
import { Subscriptions } from "./Subscriptions"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"

export interface PullRequestStanding {
  readonly pullRequest: PullRequestRef
  readonly reason: OpenReason
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
      const mirror = yield* PullRequestMirror
      const threadPullRequests = yield* ThreadPullRequests
      const decided = yield* subscriptionDecisions()

      const standingsOf = Effect.fnUntraced(function* (
        thread: Thread,
        running: PullRequestUpdate | undefined,
      ) {
        const { all } = yield* decided(thread.id)

        return all.flatMap(({ state: { subscription }, pullRequest, decision }) =>
          openReasons.flatMap((reason): ReadonlyArray<PullRequestStanding> => {
            const standing = decision.standing[reason]

            if (standing === null) return []

            const beingTold =
              running?.pullRequests.some(
                ({ subscriptionId, reasons }) =>
                  subscriptionId === subscription.id &&
                  reasons.some(({ _tag }) => subscriptionReasonOf[_tag] === reason),
              ) === true

            return [
              {
                pullRequest,
                reason,
                thread,
                state:
                  standing === "due" || (standing === "told" && beingTold) ? "handling" : "tried",
              },
            ]
          }),
        )
      })

      const standings = Effect.gen(function* () {
        const listed = Option.getOrElse(
          yield* threads.watch().pipe(Stream.runHead),
          (): ReadonlyArray<Thread> => [],
        )

        const running = yield* transcripts.runningPullRequestUpdates

        return yield* Effect.forEach(yield* subscriptions.subscribedThreads, (threadId) => {
          const thread = listed.find(({ id }) => id === threadId)

          return thread === undefined || (thread.sandbox !== null && isGone(thread.sandbox.reach))
            ? Effect.succeed([])
            : standingsOf(thread, running.find((update) => update.threadId === threadId)?.update)
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
            mirror.changes,
            threadPullRequests.watch(),
            threads.watch(),
            threads.keptGoing,
            transcripts.running,
          ]).pipe(Stream.mapEffect(() => standings)),
      })
    }),
  )
}

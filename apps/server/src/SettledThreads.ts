import type { ThreadPullRequest } from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Predicate, Schema, Stream } from "effect"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Threads } from "./Threads"
import { Transcripts, type WaitingByThread } from "./Transcripts"

const sameIds = Schema.toEquivalence(Schema.Array(Schema.String))

const isSettled = (
  { threadId, state }: ThreadPullRequest,
  running: ReadonlySet<string>,
  waiting: WaitingByThread,
  keptGoing: ReadonlyMap<string, DateTime.Utc>,
) => {
  if (!Predicate.isTagged(state, "Merged")) return false

  if (running.has(threadId) || waiting.has(threadId)) return false

  const lastKeptGoing = keptGoing.get(threadId)

  return lastKeptGoing === undefined || DateTime.isGreaterThan(state.mergedAt, lastKeptGoing)
}

export class SettledThreads extends Context.Service<
  SettledThreads,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<string>>
  }
>()("@glass/server/SettledThreads") {
  static readonly layer = Layer.effect(
    SettledThreads,
    Effect.gen(function* () {
      const pullRequests = yield* ThreadPullRequests
      const threads = yield* Threads
      const transcripts = yield* Transcripts

      return SettledThreads.of({
        watch: () =>
          Stream.zipLatestAll(
            pullRequests.watch(),
            transcripts.running,
            transcripts.waiting,
            threads.keptGoing,
          ).pipe(
            Stream.map(([listed, running, waiting, keptGoing]) =>
              listed
                .filter((pullRequest) => isSettled(pullRequest, running, waiting, keptGoing))
                .map(({ threadId }) => threadId),
            ),
            Stream.changesWith(sameIds),
          ),
      })
    }),
  )
}

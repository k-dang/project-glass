import { type Thread, ThreadPullRequest, PullRequestOpen, repositoryKey } from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Predicate,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { EventLog } from "./EventLog"
import { endedEvents } from "./gitHubSource"
import type { Branch, EndedPullRequest } from "./github/branchPullRequests"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { Threads } from "./Threads"
import { PullRequestLists } from "./PullRequestLists"
import { type Mirror, mirrorOf, openPullRequestOf, PullRequestMirror } from "./PullRequestMirror"
import { Transcripts } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const sameList = Schema.toEquivalence(Schema.Array(ThreadPullRequest))

type Ended = ReadonlyMap<string, EndedPullRequest>

const branchKey = ({ repository, branch }: Branch) => `${repositoryKey(repository)}#${branch}`

const branchOf = ({ repository, branch }: Thread): Branch | undefined =>
  branch === null ? undefined : { repository, branch }

interface Lookup extends Branch {
  readonly since: DateTime.Utc
}

const endedLookups = (
  threads: ReadonlyArray<Thread>,
  mirror: Mirror | undefined,
): ReadonlyArray<Lookup> => {
  if (mirror === undefined) return []

  const lookups = new Map<string, Lookup>()

  for (const thread of threads) {
    const branch = branchOf(thread)

    if (
      branch !== undefined &&
      branch.branch !== thread.baseBranch &&
      mirrorOf(mirror, branch.repository) !== undefined &&
      openPullRequestOf(mirror, branch) === undefined
    ) {
      const since = lookups.get(branchKey(branch))?.since ?? thread.createdAt

      lookups.set(branchKey(branch), { ...branch, since: DateTime.max(since, thread.createdAt) })
    }
  }

  return [...lookups.values()]
}

// WARNING: Deleted branches' names come back, so a PR opened before the Thread (even one its agent picked up) drops off once it ends.
const endedSince = (since: DateTime.Utc, ended: EndedPullRequest | undefined) =>
  ended !== undefined && DateTime.isGreaterThanOrEqualTo(ended.createdAt, since) ? ended : undefined

const pullRequestsOf = (
  threads: ReadonlyArray<Thread>,
  mirror: Mirror | undefined,
  ended: Ended,
): ReadonlyArray<ThreadPullRequest> =>
  mirror === undefined
    ? []
    : threads.flatMap((thread) => {
        const branch = branchOf(thread)

        if (branch === undefined) return []

        const open = openPullRequestOf(mirror, branch)

        const found =
          open === undefined
            ? endedSince(thread.createdAt, ended.get(branchKey(branch)))
            : { ...open, state: PullRequestOpen.make({ checks: open.checks }) }

        return found === undefined
          ? []
          : [
              new ThreadPullRequest({
                threadId: thread.id,
                ref: found.ref,
                url: found.url,
                title: found.title,
                state: found.state,
              }),
            ]
      })

export class ThreadPullRequests extends Context.Service<
  ThreadPullRequests,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<ThreadPullRequest>>
    readonly ofThread: (threadId: string) => Effect.Effect<ThreadPullRequest | undefined>
  }
>()("@glass/server/ThreadPullRequests") {
  static readonly layer = Layer.effect(
    ThreadPullRequests,
    Effect.gen(function* () {
      const threads = yield* Threads
      const mirror = yield* PullRequestMirror
      const lists = yield* PullRequestLists
      const transcripts = yield* Transcripts
      const github = yield* GitHubClient
      const events = yield* EventLog
      const listed = yield* SubscriptionRef.make<ReadonlyArray<ThreadPullRequest>>([])
      const ended = yield* Ref.make<Ended>(new Map())

      const asked = yield* Ref.make<{
        readonly mirrored: Mirror | undefined
        readonly keys: string
      }>({ mirrored: yield* mirror.saved, keys: "" })

      const afterTurn = (threadId: string) =>
        threads.followBranch(threadId).pipe(
          Effect.flatMap((followed) => (followed ? lists.refreshSoon : Effect.void)),
          Effect.catchCause((cause) => Effect.logWarning("Couldn't read a Thread's branch", cause)),
          Effect.withSpan("ThreadPullRequests.afterTurn", { root: true }),
        )

      yield* (yield* transcripts.subscribeEnded).pipe(
        Stream.mapEffect(afterTurn, { concurrency: "unbounded" }),
        Stream.runDrain,
        Effect.forkScoped,
      )

      const lookUpEnded = Effect.fnUntraced(function* (
        branches: ReadonlyArray<Lookup>,
        before: Mirror | undefined,
      ) {
        const known = yield* Ref.get(ended)

        const cached = (lookup: Lookup) => endedSince(lookup.since, known.get(branchKey(lookup)))

        const unknown = branches.filter((branch) => cached(branch) === undefined)
        yield* annotateUnit({ ended_lookups: unknown.length })
        const answers = yield* github.endedBranchPullRequests(unknown)
        const found = new Map(unknown.map((branch, index) => [branchKey(branch), answers[index]]))

        const remembered = Ref.set(
          ended,
          new Map(
            branches.flatMap((branch) => {
              const key = branchKey(branch)
              const pullRequest = cached(branch) ?? found.get(key)

              return pullRequest == null ? [] : [[key, pullRequest] as const]
            }),
          ),
        )

        yield* events
          .record("github", endedEvents(before, answers.filter(Predicate.isNotNull)))
          .pipe(Effect.andThen(remembered), Effect.uninterruptible)
      })

      const publish = Effect.fnUntraced(function* (
        current: ReadonlyArray<Thread>,
        mirrored: Mirror | undefined,
      ) {
        const branches = endedLookups(current, mirrored)

        const keys = branches
          .map((branch) => `${branchKey(branch)}@${DateTime.formatIso(branch.since)}`)
          .join()

        const last = yield* Ref.get(asked)

        if (mirrored !== undefined && (last.mirrored !== mirrored || last.keys !== keys)) {
          yield* lookUpEnded(branches, last.mirrored).pipe(
            Effect.andThen(Ref.set(asked, { mirrored, keys })),
            Effect.provideService(BackgroundGitHubRequest, true),
            Effect.catch((error) =>
              Effect.logWarning("Couldn't read the Threads' merged and closed PRs", error),
            ),
            Effect.withSpan("ThreadPullRequests.lookUpEnded", { root: true }),
          )
        }

        yield* SubscriptionRef.set(listed, pullRequestsOf(current, mirrored, yield* Ref.get(ended)))
      })

      yield* Stream.zipLatest(threads.watch(), mirror.changes).pipe(
        Stream.switchMap(([current, mirrored]) => Stream.fromEffect(publish(current, mirrored))),
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("Stopped following the Threads' PRs", cause),
        ),
        Effect.forkScoped,
      )

      return ThreadPullRequests.of({
        watch: () => SubscriptionRef.changes(listed).pipe(Stream.changesWith(sameList)),
        ofThread: (threadId) =>
          SubscriptionRef.get(listed).pipe(
            Effect.map((current) => current.find((own) => own.threadId === threadId)),
          ),
      })
    }),
  )
}

import {
  ActivityLogError,
  type ConnectionError,
  type FollowedRepository,
  type GitHubUnavailable,
  type LatestPullRequestListings,
  ListFailed,
  Listed,
  noListings,
  PullRequestList,
  type PullRequestListings,
  referenceKey,
  type RepositoryListing,
  RepositoryPullRequests,
  RepositoryUnavailable,
  repositoryKey,
  type SettingsError,
} from "@glass/contracts"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Predicate,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { ActivityLog } from "./ActivityLog"
import { FollowedRepositories } from "./FollowedRepositories"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import {
  type Mirror,
  type MirroredPullRequest,
  mirrorOf,
  PullRequestMirror,
  summaryOf,
} from "./PullRequestMirror"

const WATCHED_EVERY = Duration.seconds(30)

const UNWATCHED_EVERY = Duration.minutes(2)

const STALE = Number.NEGATIVE_INFINITY

interface Pace {
  readonly watchers: number
  readonly syncedAt: number | undefined
}

interface Touched {
  readonly touched: ReadonlySet<string>
  readonly problem: ActivityLogError | null
}

interface Viewer {
  readonly login: string
  readonly teams: ReadonlySet<string>
  readonly touched: ReadonlySet<string>
}

const viewerOf = (mirror: Mirror, login: string, touched: ReadonlySet<string>): Viewer => ({
  login,
  teams: new Set(mirror.teams),
  touched,
})

const belongs: Record<PullRequestList, (pr: MirroredPullRequest, viewer: Viewer) => boolean> = {
  "needs-review": (pr, viewer) =>
    !pr.viewerIsAuthor &&
    !pr.isDraft &&
    (pr.requestedUsers.includes(viewer.login.toLowerCase()) ||
      pr.requestedTeams.some((team) => viewer.teams.has(team))),
  "my-prs": (pr) => pr.viewerIsAuthor,
  reviewing: (pr, viewer) =>
    !pr.viewerIsAuthor &&
    !pr.isDraft &&
    (viewer.touched.has(referenceKey(pr.ref)) || pr.viewerHasDrafts || pr.viewerHasSubmittedReview),
}

interface RepositoryRows {
  readonly repository: FollowedRepository
  readonly mirrored: boolean
  readonly pullRequests: ReadonlyArray<MirroredPullRequest>
}

const classify = (
  mirror: Mirror,
  followed: ReadonlyArray<FollowedRepository>,
  viewer: Viewer,
): Readonly<Record<PullRequestList, ReadonlyArray<RepositoryRows>>> => {
  const rows = (list: PullRequestList) =>
    followed.map((repository): RepositoryRows => {
      const mirrored = mirrorOf(mirror, repository)

      return {
        repository,
        mirrored: mirrored !== undefined,
        pullRequests: (mirrored?.pullRequests ?? []).filter((pr) => belongs[list](pr, viewer)),
      }
    })

  return {
    "needs-review": rows("needs-review"),
    "my-prs": rows("my-prs"),
    reviewing: rows("reviewing"),
  }
}

const listingsOf = (
  lists: ReturnType<typeof classify>,
  touched: Touched,
  failures: ReadonlyMap<string, GitHubUnavailable>,
): PullRequestListings => {
  const listings = (rows: ReadonlyArray<RepositoryRows>) =>
    rows.flatMap(({ repository, mirrored, pullRequests }): ReadonlyArray<RepositoryListing> => {
      const failure = failures.get(repositoryKey(repository))
      const summaries = pullRequests.map(summaryOf)

      if (failure !== undefined) {
        return [new RepositoryUnavailable({ repository, error: failure, pullRequests: summaries })]
      }

      return mirrored ? [new RepositoryPullRequests({ repository, pullRequests: summaries })] : []
    })

  return {
    "needs-review": listings(lists["needs-review"]),
    "my-prs": listings(lists["my-prs"]),
    reviewing: listings(lists.reviewing),
    reviewingProblem: touched.problem,
  }
}

const shownIn = (lists: ReturnType<typeof classify>) => [
  ...new Map(
    Object.values(lists)
      .flat()
      .flatMap(({ pullRequests }) => pullRequests)
      .map((pr) => [pr.id, pr]),
  ).values(),
]

const later = <A>(changes: Stream.Stream<A>) => changes.pipe(Stream.drop(1), Stream.as(undefined))

interface LastSync {
  readonly failures: ReadonlyMap<string, GitHubUnavailable>
  readonly problem: SettingsError | ConnectionError | null
}

export class PullRequestLists extends Context.Service<
  PullRequestLists,
  {
    readonly list: () => Effect.Effect<PullRequestListings, SettingsError | ConnectionError>
    readonly watch: () => Stream.Stream<LatestPullRequestListings>
  }
>()("@glass/server/PullRequestLists") {
  static readonly layer = Layer.effect(
    PullRequestLists,
    Effect.gen(function* () {
      const repositories = yield* FollowedRepositories
      const github = yield* GitHubClient
      const activity = yield* ActivityLog
      const pullRequests = yield* PullRequestMirror
      const lock = yield* Semaphore.make(1)
      const launchedAt = yield* Clock.currentTimeMillis

      const touchedBy = (login: string) =>
        activity.touchedPullRequests(login).pipe(
          Effect.match({
            onSuccess: (refs): Touched => ({
              touched: new Set(refs.map(referenceKey)),
              problem: null,
            }),
            onFailure: (problem): Touched => ({ touched: new Set(), problem }),
          }),
        )

      const lastSync = yield* SubscriptionRef.make<LastSync>({ failures: new Map(), problem: null })

      const pace = yield* SubscriptionRef.make<Pace>({ watchers: 0, syncedAt: undefined })

      const derive = Effect.gen(function* () {
        const followed = yield* repositories.list()
        const { failures, problem } = yield* SubscriptionRef.get(lastSync)

        if (followed.length === 0) return Listed.make({ listings: noListings, problem })

        const mirror = yield* pullRequests.saved

        if (
          mirror === undefined ||
          (failures.size === 0 && !followed.some((repository) => mirrorOf(mirror, repository)))
        ) {
          return problem === null ? null : ListFailed.make({ problem })
        }

        const touched = yield* touchedBy(mirror.viewer)

        return Listed.make({
          listings: listingsOf(
            classify(mirror, followed, viewerOf(mirror, mirror.viewer, touched.touched)),
            touched,
            failures,
          ),
          problem,
        })
      }).pipe(
        Effect.catchTag("SettingsError", (problem) => Effect.succeed(ListFailed.make({ problem }))),
      )

      const list = Effect.fn("PullRequestLists.list")(
        function* () {
          const startedAt = yield* Clock.currentTimeMillis
          yield* SubscriptionRef.update(pace, (current) => ({ ...current, syncedAt: startedAt }))
          const followed = yield* repositories.list()

          if (followed.length === 0) {
            yield* pullRequests.forgetRepositories
            yield* SubscriptionRef.set(lastSync, { failures: new Map(), problem: null })
          } else {
            const { login } = yield* github.viewer
            const touched = yield* touchedBy(login)

            const { failures } = yield* pullRequests.sync(login, followed, (synced) =>
              shownIn(classify(synced, followed, viewerOf(synced, login, touched.touched))),
            )

            yield* SubscriptionRef.set(lastSync, { failures, problem: null })
          }

          const latest = yield* derive

          return Predicate.isTagged(latest, "Listed") ? latest.listings : noListings
        },
        Effect.tapError((problem) =>
          SubscriptionRef.update(lastSync, ({ failures }) => ({ failures, problem })),
        ),
        lock.withPermits(1),
      )

      const refresh = list().pipe(
        Effect.provideService(BackgroundGitHubRequest, true),
        Effect.withSpan("PullRequestLists.refresh", { root: true }),
        Effect.catch((error) => Effect.logWarning("Couldn't refresh the PR lists", error)),
      )

      const dueAt = ({ watchers, syncedAt }: Pace) =>
        watchers > 0
          ? (syncedAt ?? STALE) + Duration.toMillis(WATCHED_EVERY)
          : (syncedAt ?? launchedAt) + Duration.toMillis(UNWATCHED_EVERY)

      yield* repositories.changes.pipe(
        Stream.drop(1),
        Stream.runForEach(() =>
          SubscriptionRef.update(pace, (current) => ({ ...current, syncedAt: STALE })),
        ),
        Effect.forkScoped,
      )

      yield* SubscriptionRef.changes(pace).pipe(
        Stream.switchMap((current) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              const wait = dueAt(current) - (yield* Clock.currentTimeMillis)

              if (wait > 0) yield* Effect.sleep(Duration.millis(wait))
            }),
          ),
        ),
        Stream.runForEach(() => refresh),
        Effect.forkScoped,
      )

      const watching = (change: number) =>
        SubscriptionRef.update(pace, (current) => ({
          ...current,
          watchers: current.watchers + change,
        }))

      const changed = Stream.mergeAll(
        [
          later(pullRequests.changes),
          later(activity.changes),
          later(repositories.changes),
          later(SubscriptionRef.changes(lastSync)),
        ],
        { concurrency: "unbounded" },
      )

      return PullRequestLists.of({
        list,
        watch: () =>
          Stream.concat(Stream.make(undefined), changed).pipe(
            Stream.mapEffect(() => derive),
            Stream.filter(Predicate.isNotNull),
            Stream.onStart(watching(1)),
            Stream.ensuring(watching(-1)),
          ),
      })
    }),
  )
}

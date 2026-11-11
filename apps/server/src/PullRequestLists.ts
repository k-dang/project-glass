import {
  ActivityLogError,
  type ConnectionError,
  type FollowedRepository,
  type GitHubUnavailable,
  noListings,
  PullRequestList,
  type PullRequestListings,
  PullRequestSummary,
  referenceKey,
  type RepositoryListing,
  RepositoryPullRequests,
  RepositoryUnavailable,
  repositoryKey,
  type SettingsError,
} from "@glass/contracts"
import { Array as Arr, Context, DateTime, Effect, Layer, Stream, SubscriptionRef } from "effect"
import { ActivityLog } from "./ActivityLog"
import { FollowedRepositories } from "./FollowedRepositories"
import { GitHubClient } from "./github/GitHubClient"
import {
  type Mirror,
  type MirroredPullRequest,
  mirrorOf,
  PullRequestMirror,
} from "./PullRequestMirror"

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

/** The outstanding Review requests on a PR that ask the user or one of their teams. */
const viewerRequests = (pr: MirroredPullRequest, viewer: Viewer) => [
  ...pr.requestedUsers.filter((user) => user === viewer.login.toLowerCase()),
  ...pr.requestedTeams.filter((team) => viewer.teams.has(team)),
]

const belongs: Record<PullRequestList, (pr: MirroredPullRequest, viewer: Viewer) => boolean> = {
  "needs-review": (pr, viewer) =>
    !pr.viewerIsAuthor && !pr.isDraft && viewerRequests(pr, viewer).length > 0,
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

const summaryOf = (pr: MirroredPullRequest) =>
  new PullRequestSummary({
    ref: pr.ref,
    url: pr.url,
    title: pr.title,
    author: pr.author,
    isDraft: pr.isDraft,
    checks: pr.checks,
    updatedAt: pr.updatedAt,
  })

/** A PR in Needs review, since the earliest of its Review requests to the user or their teams. */
export interface RequestedReview {
  readonly pullRequest: PullRequestSummary
  readonly since: DateTime.Utc
}

const requestedReviewsOf = (
  rows: ReadonlyArray<RepositoryRows>,
  viewer: Viewer,
): ReadonlyArray<RequestedReview> =>
  rows.flatMap(({ pullRequests }) =>
    pullRequests.flatMap((pr) => {
      const requests = viewerRequests(pr, viewer)

      // A mirror saved before requestedSince existed has no times, so its requests count from the PR's last update.
      return Arr.isReadonlyArrayNonEmpty(requests)
        ? [
            {
              pullRequest: summaryOf(pr),
              since: Arr.min(
                Arr.map(requests, (key) => pr.requestedSince[key] ?? pr.updatedAt),
                DateTime.Order,
              ),
            },
          ]
        : []
    }),
  )

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

export class PullRequestLists extends Context.Service<
  PullRequestLists,
  {
    readonly list: () => Effect.Effect<PullRequestListings, SettingsError | ConnectionError>
    readonly saved: () => Effect.Effect<PullRequestListings | null, SettingsError>
    /** The Needs review rows as of the latest `list()`, again after each one. Starts from the saved mirror. */
    readonly watchNeedsReview: () => Stream.Stream<ReadonlyArray<RequestedReview>>
  }
>()("@glass/server/PullRequestLists") {
  static readonly layer = Layer.effect(
    PullRequestLists,
    Effect.gen(function* () {
      const repositories = yield* FollowedRepositories
      const github = yield* GitHubClient
      const activity = yield* ActivityLog
      const pullRequests = yield* PullRequestMirror

      const savedRequests = Effect.gen(function* () {
        const followed = yield* repositories.list()
        const mirror = yield* pullRequests.saved

        if (mirror === undefined) return []

        const viewer = viewerOf(mirror, mirror.viewer, new Set())

        return requestedReviewsOf(classify(mirror, followed, viewer)["needs-review"], viewer)
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read the saved Review requests", cause).pipe(Effect.as([])),
        ),
      )

      const needsReview = yield* SubscriptionRef.make<ReadonlyArray<RequestedReview>>(
        yield* savedRequests,
      )

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

      return PullRequestLists.of({
        list: Effect.fn("PullRequestLists.list")(function* () {
          const followed = yield* repositories.list()

          if (followed.length === 0) {
            yield* SubscriptionRef.set(needsReview, [])

            return noListings
          }

          const { login } = yield* github.viewer
          const touched = yield* touchedBy(login)

          const { mirror, failures } = yield* pullRequests.sync(login, followed, (synced) =>
            shownIn(classify(synced, followed, viewerOf(synced, login, touched.touched))),
          )

          const viewer = viewerOf(mirror, login, touched.touched)
          const lists = classify(mirror, followed, viewer)

          yield* SubscriptionRef.set(needsReview, requestedReviewsOf(lists["needs-review"], viewer))

          return listingsOf(lists, touched, failures)
        }),
        saved: Effect.fn("PullRequestLists.saved")(function* () {
          const followed = yield* repositories.list()
          const mirror = yield* pullRequests.saved

          if (
            mirror === undefined ||
            !followed.some((repository) => mirrorOf(mirror, repository))
          ) {
            return null
          }

          const touched = yield* touchedBy(mirror.viewer)

          return listingsOf(
            classify(mirror, followed, viewerOf(mirror, mirror.viewer, touched.touched)),
            touched,
            new Map(),
          )
        }),
        watchNeedsReview: () => SubscriptionRef.changes(needsReview),
      })
    }),
  )
}

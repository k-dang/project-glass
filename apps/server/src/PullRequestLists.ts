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
import { Context, Effect, Layer } from "effect"
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
  login: string,
  { touched }: Touched,
): Readonly<Record<PullRequestList, ReadonlyArray<RepositoryRows>>> => {
  const viewer: Viewer = { login, teams: new Set(mirror.teams), touched }

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
  }
>()("@glass/server/PullRequestLists") {
  static readonly layer = Layer.effect(
    PullRequestLists,
    Effect.gen(function* () {
      const repositories = yield* FollowedRepositories
      const github = yield* GitHubClient
      const activity = yield* ActivityLog
      const pullRequests = yield* PullRequestMirror

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

          if (followed.length === 0) return noListings

          const { login } = yield* github.viewer
          const touched = yield* touchedBy(login)

          const { mirror, failures } = yield* pullRequests.sync(login, followed, (synced) =>
            shownIn(classify(synced, followed, login, touched)),
          )

          return listingsOf(classify(mirror, followed, login, touched), touched, failures)
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

          return listingsOf(classify(mirror, followed, mirror.viewer, touched), touched, new Map())
        }),
      })
    }),
  )
}

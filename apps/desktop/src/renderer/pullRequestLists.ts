import type {
  FollowedRepository,
  PullRequestList,
  PullRequestListings,
  PullRequestSummary,
  RepositoryListing,
} from "@glass/contracts"
import { Data, Effect, Match, Option, Record } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, type BackendError, backendRuntime } from "./backend"
import { followedRepositoriesRevisionAtom } from "./FollowedRepositories"
import { describeError, type Problem, problemOf } from "./problems"
import { watched } from "./watched"
import { reviewingRevisionAtom } from "./workspaceEvents"

export type Health = Data.TaggedEnum<{
  Current: {}
  NotRefreshed: { readonly problem: Problem }
  Unavailable: { readonly problem: Problem }
}>

export const Health = Data.taggedEnum<Health>()

export interface Group {
  readonly repository: FollowedRepository
  readonly pullRequests: ReadonlyArray<PullRequestSummary>
  readonly health: Health
}

interface Listing {
  readonly groups: ReadonlyArray<Group>
  readonly problem: Problem | undefined
  readonly notRefreshed: Problem | undefined
}

type Listings = Readonly<Record<PullRequestList, Listing>>

const groupOf = (listing: RepositoryListing): Group =>
  Match.valueTags(listing, {
    RepositoryPullRequests: ({ repository, pullRequests }): Group => ({
      repository,
      pullRequests,
      health: Health.Current(),
    }),
    RepositoryUnavailable: ({ repository, error, pullRequests }): Group => ({
      repository,
      pullRequests,
      health:
        pullRequests.length > 0
          ? Health.NotRefreshed({ problem: describeError(error) })
          : Health.Unavailable({ problem: describeError(error) }),
    }),
  })

const markNotRefreshed =
  (problem: Problem) =>
  (group: Group): Group =>
    Health.$is("Current")(group.health) && group.pullRequests.length > 0
      ? { ...group, health: Health.NotRefreshed({ problem }) }
      : group

const listed = (repositories: ReadonlyArray<RepositoryListing>): Listing => ({
  groups: repositories.map(groupOf),
  problem: undefined,
  notRefreshed: undefined,
})

const listingsOf = (listings: PullRequestListings): Listings => ({
  "needs-review": listed(listings["needs-review"]),
  "my-prs": listed(listings["my-prs"]),
  reviewing: {
    groups: listings.reviewing.map(groupOf),
    problem:
      listings.reviewingProblem === null ? undefined : describeError(listings.reviewingProblem),
    notRefreshed: undefined,
  },
})

const CACHE_IDLE_TTL = "5 minutes"

const listingsAtom = backendRuntime
  .atom((get) => {
    get(followedRepositoriesRevisionAtom)
    get(reviewingRevisionAtom)

    const load = (known: Option.Option<Listings>) =>
      Backend.use((backend) => backend.ListPullRequests()).pipe(
        Effect.map(listingsOf),
        Effect.catchCause((cause) =>
          Option.match(known, {
            onNone: () => Effect.failCause(cause),
            onSome: (lists): Effect.Effect<Listings> => {
              const problem = problemOf(cause)

              return Effect.succeed(
                Record.map(lists, (listing) => ({
                  ...listing,
                  groups: listing.groups.map(markNotRefreshed(problem)),
                  notRefreshed: problem,
                })),
              )
            },
          }),
        ),
      )

    const known = get
      .self<AsyncResult.AsyncResult<Listings, BackendError>>()
      .pipe(Option.flatMap(AsyncResult.value))

    if (Option.isSome(known)) return load(known)

    return Effect.gen(function* () {
      const saved = yield* Backend.use((backend) => backend.ListSavedPullRequests()).pipe(
        Effect.map((listings) => Option.map(Option.fromNullOr(listings), listingsOf)),
        Effect.orElseSucceed(() => Option.none<Listings>()),
      )

      if (Option.isSome(saved)) get.setSelf(AsyncResult.success(saved.value, { waiting: true }))

      return yield* load(saved)
    })
  })
  .pipe(Atom.setIdleTTL(CACHE_IDLE_TTL))

/** The PR lists, kept fresh while the window is visible. The Reviews area and Needs you share this one poll. */
export const watchedListingsAtom = watched(listingsAtom)

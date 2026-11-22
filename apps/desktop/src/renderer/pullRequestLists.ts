import {
  type FollowedRepository,
  type LatestPullRequestListings,
  type PullRequestList,
  type PullRequestListings,
  type PullRequestRef,
  type PullRequestSummary,
  type RepositoryListing,
  referenceKey,
} from "@glass/contracts"
import { Data, Effect, Match, Option, Record, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"
import { describeError, type Problem } from "./problems"
import { savedQueueAtom } from "./queue"

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

export type Latest = Data.TaggedEnum<{
  Listed: { readonly listings: Listings }
  Failed: { readonly problem: Problem }
}>

export const Latest = Data.taggedEnum<Latest>()

const notRefreshed = (listings: Listings, problem: Problem): Listings =>
  Record.map(listings, (listing) => ({
    ...listing,
    groups: listing.groups.map(markNotRefreshed(problem)),
    notRefreshed: problem,
  }))

const latestOf = (update: LatestPullRequestListings): Latest =>
  Match.valueTags(update, {
    Listed: ({ listings, problem }) =>
      Latest.Listed({
        listings:
          problem === null
            ? listingsOf(listings)
            : notRefreshed(listingsOf(listings), describeError(problem)),
      }),
    ListFailed: ({ problem }) => Latest.Failed({ problem: describeError(problem) }),
  })

const visible = () => document.visibilityState === "visible"

const documentVisibleAtom = Atom.make((get) => {
  const changed = () => get.setSelf(visible())

  document.addEventListener("visibilitychange", changed)
  get.addFinalizer(() => document.removeEventListener("visibilitychange", changed))

  return visible()
})

const lastSeenAtom = Atom.make(Option.none<Latest>()).pipe(Atom.keepAlive)

export const listingsAtom = backendRuntime.atom((get) => {
  const lastSeen = Stream.fromIterable(Option.toArray(get.once(lastSeenAtom)))

  if (!get(documentVisibleAtom)) return Stream.concat(lastSeen, Stream.never)

  return Stream.concat(
    lastSeen,
    Stream.unwrap(Backend.useSync((backend) => backend.WatchPullRequests())).pipe(
      Stream.map(latestOf),
      Stream.tap((latest) => Effect.sync(() => get.set(lastSeenAtom, Option.some(latest)))),
    ),
  )
})

export const syncListingsAtom = backendRuntime
  .fn(() => Backend.use((backend) => backend.ListPullRequests()))
  .pipe(Atom.keepAlive)

interface KnownPullRequest {
  readonly ref: PullRequestRef
  readonly title: string
}

export const knownPullRequestsAtom = Atom.make((get): ReadonlyArray<KnownPullRequest> => {
  const known = new Map<string, KnownPullRequest>()
  const add = ({ ref, title }: KnownPullRequest) => known.set(referenceKey(ref), { ref, title })

  for (const { pullRequest } of Option.getOrElse(AsyncResult.value(get(savedQueueAtom)), () => []))
    add(pullRequest)

  const latest = Option.getOrNull(get(lastSeenAtom))

  if (latest?._tag === "Listed")
    for (const listing of Object.values(latest.listings))
      for (const group of listing.groups)
        for (const pullRequest of group.pullRequests) add(pullRequest)

  return [...known.values()]
})

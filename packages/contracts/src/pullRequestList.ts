import { Schema } from "effect"
import { ActivityLogError } from "./activity"
import { ConnectionError, GitHubUnavailable } from "./connection"
import { FollowedRepository } from "./followedRepository"
import { PullRequestRef } from "./pullRequest"
import { SettingsError } from "./settings"

export const PullRequestList = Schema.Literals(["needs-review", "my-prs", "reviewing"])

export type PullRequestList = typeof PullRequestList.Type

export const Checks = Schema.Literals(["passing", "failing", "running", "unavailable"])

export type Checks = typeof Checks.Type

export class PullRequestSummary extends Schema.Class<PullRequestSummary>("PullRequestSummary")({
  ref: PullRequestRef,
  url: Schema.String,
  title: Schema.String,
  author: Schema.String,
  isDraft: Schema.Boolean,
  checks: Checks,
  updatedAt: Schema.DateTimeUtcFromString,
}) {}

export class RepositoryPullRequests extends Schema.TaggedClass<RepositoryPullRequests>()(
  "RepositoryPullRequests",
  {
    repository: FollowedRepository,
    pullRequests: Schema.Array(PullRequestSummary),
  },
) {}

export class RepositoryUnavailable extends Schema.TaggedClass<RepositoryUnavailable>()(
  "RepositoryUnavailable",
  {
    repository: FollowedRepository,
    error: GitHubUnavailable,
    pullRequests: Schema.Array(PullRequestSummary),
  },
) {}

export const RepositoryListing = Schema.Union([RepositoryPullRequests, RepositoryUnavailable])

export type RepositoryListing = typeof RepositoryListing.Type

const Listings = Schema.Array(RepositoryListing)

export const PullRequestListings = Schema.Struct({
  "needs-review": Listings,
  "my-prs": Listings,
  reviewing: Listings,
  reviewingProblem: Schema.NullOr(ActivityLogError),
})

export type PullRequestListings = typeof PullRequestListings.Type

export const noListings: PullRequestListings = {
  "needs-review": [],
  "my-prs": [],
  reviewing: [],
  reviewingProblem: null,
}

const ListingsProblem = Schema.Union([SettingsError, ConnectionError])

export const Listed = Schema.TaggedStruct("Listed", {
  listings: PullRequestListings,
  problem: Schema.NullOr(ListingsProblem),
})

export const ListFailed = Schema.TaggedStruct("ListFailed", { problem: ListingsProblem })

export const LatestPullRequestListings = Schema.Union([Listed, ListFailed])

export type LatestPullRequestListings = typeof LatestPullRequestListings.Type

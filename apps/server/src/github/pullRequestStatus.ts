import { type Approval, type Mergeable, Reviewer } from "@glass/contracts"
import { Schema } from "effect"
import { GitHubAuthor, login } from "./author"
import { CHECK_CONTEXTS_FIELDS, CheckContexts, checksOfCommits } from "./checkContexts"
import { ReviewRequest, ReviewState } from "./repositoryPullRequests"

const MAX_STATUS_ITEMS = 100

export const PULL_REQUEST_STATUS_FIELDS = `reviewDecision
      mergeable
      latestOpinionatedReviews(first: ${MAX_STATUS_ITEMS}) { nodes { author { login } state } }
      reviewRequests(first: ${MAX_STATUS_ITEMS}) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
      }
      ${CHECK_CONTEXTS_FIELDS}`

export const PullRequestStatusFields = {
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
  ),
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  latestOpinionatedReviews: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: GitHubAuthor,
        state: ReviewState,
      }),
    ),
  }),
  reviewRequests: Schema.Struct({ nodes: Schema.Array(ReviewRequest) }),
  commits: CheckContexts,
}

type GitHubPullRequestStatus = Schema.Struct.Type<typeof PullRequestStatusFields>

const approvals: Record<NonNullable<GitHubPullRequestStatus["reviewDecision"]>, Approval> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes-requested",
  REVIEW_REQUIRED: "review-required",
}

const mergeables: Record<GitHubPullRequestStatus["mergeable"], Mergeable> = {
  MERGEABLE: "mergeable",
  CONFLICTING: "conflicting",
  UNKNOWN: "checking",
}

const requestedName = (reviewer: (typeof ReviewRequest.Type)["requestedReviewer"]) => {
  switch (reviewer?.__typename) {
    case "User":
      return reviewer.login
    case "Team":
      return `${reviewer.organization.login}/${reviewer.slug}`
    default:
      return undefined
  }
}

const toReviewers = (pr: GitHubPullRequestStatus) => {
  const reviewers = new Map<string, Reviewer>()

  for (const review of pr.latestOpinionatedReviews.nodes) {
    if (review.state !== "APPROVED" && review.state !== "CHANGES_REQUESTED") continue

    const name = login(review.author)
    const state = review.state === "APPROVED" ? "approved" : "changes-requested"
    reviewers.set(name, new Reviewer({ name, state }))
  }

  for (const { requestedReviewer: reviewer } of pr.reviewRequests.nodes) {
    const name = requestedName(reviewer)

    if (name !== undefined) reviewers.set(name, new Reviewer({ name, state: "requested" }))
  }

  return [...reviewers.values()]
}

export const toPullRequestStatus = (pr: GitHubPullRequestStatus) => ({
  approval: pr.reviewDecision === null ? null : approvals[pr.reviewDecision],
  reviewers: toReviewers(pr),
  checks: checksOfCommits(pr.commits),
  mergeable: mergeables[pr.mergeable],
})

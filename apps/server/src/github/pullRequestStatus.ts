import { type Approval, Check, type CheckState, type Mergeable, Reviewer } from "@glass/contracts"
import { Schema } from "effect"
import { GitHubAuthor, login } from "./author"
import { ReviewRequest, StatusState } from "./repositoryPullRequests"

const MAX_STATUS_ITEMS = 100

export const PULL_REQUEST_STATUS_FIELDS = `reviewDecision
      mergeable
      latestOpinionatedReviews(first: ${MAX_STATUS_ITEMS}) { nodes { author { login } state } }
      reviewRequests(first: ${MAX_STATUS_ITEMS}) {
        nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
      }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: ${MAX_STATUS_ITEMS}) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state targetUrl }
      } } } } } }`

const CheckRun = Schema.Struct({
  __typename: Schema.Literal("CheckRun"),
  name: Schema.String,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  detailsUrl: Schema.NullOr(Schema.String),
  checkSuite: Schema.Struct({
    workflowRun: Schema.NullOr(Schema.Struct({ workflow: Schema.Struct({ name: Schema.String }) })),
  }),
})

const StatusContext = Schema.Struct({
  __typename: Schema.Literal("StatusContext"),
  context: Schema.String,
  state: StatusState,
  targetUrl: Schema.NullOr(Schema.String),
})

export const PullRequestStatusFields = {
  reviewDecision: Schema.NullOr(
    Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]),
  ),
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  latestOpinionatedReviews: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        author: GitHubAuthor,
        state: Schema.Literals([
          "APPROVED",
          "CHANGES_REQUESTED",
          "COMMENTED",
          "DISMISSED",
          "PENDING",
        ]),
      }),
    ),
  }),
  reviewRequests: Schema.Struct({ nodes: Schema.Array(ReviewRequest) }),
  commits: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        commit: Schema.Struct({
          statusCheckRollup: Schema.NullOr(
            Schema.Struct({
              contexts: Schema.Struct({
                nodes: Schema.Array(Schema.Union([CheckRun, StatusContext])),
              }),
            }),
          ),
        }),
      }),
    ),
  }),
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

const checkRunState = (run: typeof CheckRun.Type): CheckState => {
  if (run.status !== "COMPLETED") return "running"

  switch (run.conclusion) {
    case "SUCCESS":
    case "NEUTRAL":
      return "passed"
    case "SKIPPED":
    case "STALE":
      return "skipped"
    default:
      return "failed"
  }
}

const statusStates: Record<typeof StatusState.Type, CheckState> = {
  SUCCESS: "passed",
  FAILURE: "failed",
  ERROR: "failed",
  PENDING: "running",
  EXPECTED: "running",
}

const toCheck = (context: typeof CheckRun.Type | typeof StatusContext.Type) => {
  if (context.__typename === "StatusContext") {
    return new Check({
      name: context.context,
      state: statusStates[context.state],
      url: context.targetUrl,
    })
  }

  const workflow = context.checkSuite.workflowRun?.workflow.name

  return new Check({
    name: workflow === undefined ? context.name : `${workflow} / ${context.name}`,
    state: checkRunState(context),
    url: context.detailsUrl,
  })
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
  checks: (pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []).map(toCheck),
  mergeable: mergeables[pr.mergeable],
})

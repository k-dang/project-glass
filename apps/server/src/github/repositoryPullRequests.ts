import { type Checks, type FollowedRepository, PullRequestRef } from "@glass/contracts"
import { DateTime, Schema } from "effect"
import { GitHubAuthor, login } from "./author"

const CANDIDATE_FIELDS = `id number url title author { login } updatedAt isDraft state viewerDidAuthor
  repository { owner { login } name }
  pendingReviews: reviews(states: PENDING, first: 1) { nodes { comments { totalCount } } }
  viewerSubmittedReviews: reviews(author: $viewerLogin, states: [APPROVED, CHANGES_REQUESTED, COMMENTED, DISMISSED], first: 1) { nodes { id } }
  reviewRequests(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
  }`

export const REPOSITORY_PULL_REQUESTS_QUERY = `query RepositoryPullRequests($owner: String!, $name: String!, $viewerLogin: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, orderBy: {field: UPDATED_AT, direction: DESC}, first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${CANDIDATE_FIELDS} }
    }
  }
}`

export const updatedSinceSearch = ({ owner, repo }: FollowedRepository, since: DateTime.Utc) =>
  `repo:${owner}/${repo} is:pr updated:>=${DateTime.formatIso(since)} sort:updated-desc`

export const SEARCH_PULL_REQUESTS_QUERY = `query SearchPullRequests($query: String!, $viewerLogin: String!, $after: String) {
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${CANDIDATE_FIELDS} } }
  }
}`

export const PULL_REQUEST_CHECKS_QUERY = `query PullRequestChecks($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  }
}`

export const REVIEW_REQUESTS_QUERY = `query PullRequestReviewRequests($id: ID!, $after: String) {
  node(id: $id) { ... on PullRequest {
    connection: reviewRequests(first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug organization { login } } } }
    }
  } }
}`

const PageInfo = Schema.Union([
  Schema.Struct({ hasNextPage: Schema.Literal(true), endCursor: Schema.NonEmptyString }),
  Schema.Struct({ hasNextPage: Schema.Literal(false), endCursor: Schema.NullOr(Schema.String) }),
])

export const ReviewRequest = Schema.Struct({
  requestedReviewer: Schema.NullOr(
    Schema.Union([
      Schema.Struct({ __typename: Schema.Literal("User"), login: Schema.NonEmptyString }),
      Schema.Struct({
        __typename: Schema.Literal("Team"),
        slug: Schema.NonEmptyString,
        organization: Schema.Struct({ login: Schema.NonEmptyString }),
      }),
      Schema.Struct({ __typename: Schema.Literals(["Bot", "Mannequin", "EnterpriseTeam"]) }),
    ]),
  ),
})

export const ReviewRequestsConnection = Schema.Struct({
  pageInfo: PageInfo,
  nodes: Schema.Array(ReviewRequest),
})

export interface ReviewRequestsPage {
  readonly users: ReadonlyArray<string>
  readonly teams: ReadonlyArray<string>
  readonly nextCursor: string | null
}

export const toReviewRequestsPage = (
  page: typeof ReviewRequestsConnection.Type,
): ReviewRequestsPage => {
  const users: Array<string> = []
  const teams: Array<string> = []

  for (const { requestedReviewer: reviewer } of page.nodes) {
    switch (reviewer?.__typename) {
      case "User":
        users.push(reviewer.login.toLowerCase())
        break
      case "Team":
        teams.push(`${reviewer.organization.login}/${reviewer.slug}`.toLowerCase())
        break
      default:
        break
    }
  }

  return { users, teams, nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null }
}

export const StatusState = Schema.Literals(["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"])

const GitHubCandidate = Schema.Struct({
  id: Schema.String,
  number: Schema.Int,
  repository: Schema.Struct({
    owner: Schema.Struct({ login: Schema.String }),
    name: Schema.String,
  }),
  url: Schema.String,
  title: Schema.String,
  author: GitHubAuthor,
  updatedAt: Schema.DateTimeUtcFromString,
  isDraft: Schema.Boolean,
  state: Schema.Literals(["OPEN", "CLOSED", "MERGED"]),
  viewerDidAuthor: Schema.Boolean,
  viewerSubmittedReviews: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String })),
  }),
  pendingReviews: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        comments: Schema.Struct({ totalCount: Schema.Int }),
      }),
    ),
  }),
  reviewRequests: ReviewRequestsConnection,
})

export interface Candidate {
  readonly id: string
  readonly ref: PullRequestRef
  readonly url: string
  readonly title: string
  readonly author: string
  readonly isDraft: boolean
  readonly isOpen: boolean
  readonly updatedAt: DateTime.Utc
  readonly viewerIsAuthor: boolean
  readonly viewerHasDrafts: boolean
  readonly viewerHasSubmittedReview: boolean
  readonly reviewRequests: ReviewRequestsPage
}

export interface CandidatesPage {
  readonly candidates: ReadonlyArray<Candidate>
  readonly nextCursor: string | null
}

const CandidatesConnection = Schema.Struct({
  pageInfo: PageInfo,
  nodes: Schema.Array(GitHubCandidate),
})

export const RepositoryPullRequestsData = Schema.Struct({
  repository: Schema.NullOr(Schema.Struct({ pullRequests: CandidatesConnection })),
})

export const SearchPullRequestsData = Schema.Struct({ search: CandidatesConnection })

export const PullRequestChecksData = Schema.Struct({
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        commits: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              commit: Schema.Struct({
                statusCheckRollup: Schema.NullOr(Schema.Struct({ state: StatusState })),
              }),
            }),
          ),
        }),
      }),
    ),
  ),
})

const checksOf: Record<typeof StatusState.Type, Checks> = {
  SUCCESS: "passing",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "running",
  EXPECTED: "running",
}

export const toCheck = (
  rollup: { readonly state: typeof StatusState.Type } | null | undefined,
): Checks => (rollup == null ? "unavailable" : checksOf[rollup.state])

export const toChecks = (data: typeof PullRequestChecksData.Type): ReadonlyMap<string, Checks> =>
  new Map(
    data.nodes.flatMap((node) =>
      node === null
        ? []
        : [[node.id, toCheck(node.commits.nodes[0]?.commit.statusCheckRollup)] as const],
    ),
  )

export const toCandidatesPage = (page: typeof CandidatesConnection.Type): CandidatesPage => ({
  candidates: page.nodes.map((node) => ({
    id: node.id,
    ref: new PullRequestRef({
      owner: node.repository.owner.login,
      repo: node.repository.name,
      number: node.number,
    }),
    url: node.url,
    title: node.title,
    author: login(node.author),
    isDraft: node.isDraft,
    isOpen: node.state === "OPEN",
    updatedAt: node.updatedAt,
    viewerIsAuthor: node.viewerDidAuthor,
    viewerHasDrafts: (node.pendingReviews.nodes[0]?.comments.totalCount ?? 0) > 0,
    viewerHasSubmittedReview: node.viewerSubmittedReviews.nodes.length > 0,
    reviewRequests: toReviewRequestsPage(node.reviewRequests),
  })),
  nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
})

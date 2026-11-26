import { Check, type Checks, type FollowedRepository, PullRequestRef } from "@glass/contracts"
import { DateTime, Schema } from "effect"
import { GitHubAuthor, login } from "./author"
import {
  CHECK_CONTEXTS_FIELDS,
  CheckContexts,
  checksOfCommits,
  checksOfRollup,
  StatusState,
} from "./checkContexts"

export const GitHubPullRequestState = Schema.Literals(["OPEN", "CLOSED", "MERGED"])

const CANDIDATE_FIELDS = `id number url title author { login } updatedAt headRefOid headRefName isCrossRepository isDraft state viewerDidAuthor
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

export const PULL_REQUEST_OBSERVATIONS_QUERY = `query PullRequestObservations($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest { id state headRefOid commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
  }
}`

export const PULL_REQUEST_ATTENTION_QUERY = `query PullRequestAttention($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      mergeStateStatus
      mergeable
      latestOpinionatedReviews(first: 100) { nodes { state } }
      reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { viewerDidAuthor } } } }
      ${CHECK_CONTEXTS_FIELDS}
    }
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

export const ReviewState = Schema.Literals([
  "APPROVED",
  "CHANGES_REQUESTED",
  "COMMENTED",
  "DISMISSED",
  "PENDING",
])

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
  headRefOid: Schema.String,
  headRefName: Schema.String,
  isCrossRepository: Schema.Boolean,
  isDraft: Schema.Boolean,
  state: GitHubPullRequestState,
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
  readonly head: string
  readonly headBranch: string | null
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

export const PullRequestObservationsData = Schema.Struct({
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        state: GitHubPullRequestState,
        headRefOid: Schema.String,
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

export interface PullRequestObservation {
  readonly isOpen: boolean
  readonly head: string
  readonly checks: Checks
}

export const toObservations = (
  data: typeof PullRequestObservationsData.Type,
): ReadonlyMap<string, PullRequestObservation> =>
  new Map(
    data.nodes.flatMap((node) =>
      node === null
        ? []
        : [
            [
              node.id,
              {
                isOpen: node.state === "OPEN",
                head: node.headRefOid,
                checks: checksOfRollup(node.commits.nodes[0]?.commit.statusCheckRollup),
              },
            ] as const,
          ],
    ),
  )

const attentionFields = {
  id: Schema.String,
  mergeStateStatus: Schema.String,
  mergeable: Schema.Literals(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  commits: CheckContexts,
}

const AttentionNode = Schema.Struct({
  ...attentionFields,
  latestOpinionatedReviews: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ state: ReviewState })),
  }),
  reviewThreads: Schema.Struct({
    nodes: Schema.Array(
      Schema.Struct({
        isResolved: Schema.Boolean,
        comments: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ viewerDidAuthor: Schema.Boolean })),
        }),
      }),
    ),
  }),
})

export const PullRequestAttentionData = Schema.Struct({
  nodes: Schema.Array(Schema.NullOr(AttentionNode)),
})

export const Attention = Schema.Struct({
  changesRequested: Schema.Boolean,
  approved: Schema.Boolean,
  mergeClean: Schema.Boolean,
  mergeConflict: Schema.NullOr(Schema.Boolean),
  awaitingReply: Schema.Int,
  failingChecks: Schema.Array(Check),
})

export type Attention = typeof Attention.Type

const cleanMergeStates = new Set(["CLEAN", "HAS_HOOKS"])

const awaitsReply = ({
  isResolved,
  comments,
}: (typeof AttentionNode.Type)["reviewThreads"]["nodes"][number]) =>
  !isResolved && comments.nodes.at(-1)?.viewerDidAuthor === false

const attentionOf = (node: typeof AttentionNode.Type): Attention => {
  const states = node.latestOpinionatedReviews.nodes.map(({ state }) => state)

  return {
    changesRequested: states.includes("CHANGES_REQUESTED"),
    approved: states.includes("APPROVED"),
    mergeClean: cleanMergeStates.has(node.mergeStateStatus),
    mergeConflict: node.mergeable === "UNKNOWN" ? null : node.mergeable === "CONFLICTING",
    awaitingReply: node.reviewThreads.nodes.filter(awaitsReply).length,
    failingChecks: checksOfCommits(node.commits).filter((check) => check.state === "failed"),
  }
}

export const toAttention = (
  data: typeof PullRequestAttentionData.Type,
): ReadonlyMap<string, Attention> =>
  new Map(data.nodes.flatMap((node) => (node === null ? [] : [[node.id, attentionOf(node)]])))

const MAX_THREAD_COMMENTS = 20

export const SUBSCRIBED_PULL_REQUESTS_QUERY = `query SubscribedPullRequests($ids: [ID!]!) {
  nodes(ids: $ids) {
    ... on PullRequest {
      id
      headRefOid
      baseRefOid
      mergeStateStatus
      mergeable
      latestOpinionatedReviews(first: 100) { nodes { id state authorAssociation author { login } } }
      reviewThreads(first: 100) { nodes {
        id isResolved path line
        comments(last: ${MAX_THREAD_COMMENTS}) { nodes { id body authorAssociation viewerDidAuthor author { login } } }
      } }
      ${CHECK_CONTEXTS_FIELDS}
    }
  }
}`

const gitHubAuthorFields = {
  author: GitHubAuthor,
  authorAssociation: Schema.String,
}

export const SubscribedPullRequestsData = Schema.Struct({
  nodes: Schema.Array(
    Schema.NullOr(
      Schema.Struct({
        ...attentionFields,
        headRefOid: Schema.String,
        baseRefOid: Schema.String,
        latestOpinionatedReviews: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({ id: Schema.String, state: ReviewState, ...gitHubAuthorFields }),
          ),
        }),
        reviewThreads: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              isResolved: Schema.Boolean,
              path: Schema.String,
              line: Schema.NullOr(Schema.Int),
              comments: Schema.Struct({
                nodes: Schema.Array(
                  Schema.Struct({
                    id: Schema.String,
                    body: Schema.String,
                    viewerDidAuthor: Schema.Boolean,
                    ...gitHubAuthorFields,
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    ),
  ),
})

const authorFields = { author: Schema.String, hasWriteAccess: Schema.Boolean }

export const SubscribedDetails = Schema.Struct({
  head: Schema.String,
  base: Schema.String,
  reviewThreads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      line: Schema.NullOr(Schema.Int),
      comments: Schema.Array(
        Schema.Struct({ id: Schema.String, body: Schema.String, ...authorFields }),
      ),
    }),
  ),
  changesRequested: Schema.Array(Schema.Struct({ reviewId: Schema.String, ...authorFields })),
})

export type SubscribedDetails = typeof SubscribedDetails.Type

export interface SubscribedPullRequest {
  readonly attention: Attention
  readonly details: SubscribedDetails
}

// WARNING: GitHub's author association is the only sign of write access a PR's comments carry. A member or collaborator can have read access alone, and still counts here.
const writeAccess = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

const authorOf = ({
  author,
  authorAssociation,
}: {
  readonly author: typeof GitHubAuthor.Type
  readonly authorAssociation: string
}) => ({
  author: login(author),
  hasWriteAccess: writeAccess.has(authorAssociation),
})

export const toSubscribedPullRequests = (
  data: typeof SubscribedPullRequestsData.Type,
): ReadonlyMap<string, SubscribedPullRequest> =>
  new Map(
    data.nodes.flatMap((node) =>
      node === null
        ? []
        : [
            [
              node.id,
              {
                attention: attentionOf(node),
                details: {
                  head: node.headRefOid,
                  base: node.baseRefOid,
                  reviewThreads: node.reviewThreads.nodes.filter(awaitsReply).map((thread) => ({
                    id: thread.id,
                    path: thread.path,
                    line: thread.line,
                    comments: thread.comments.nodes.map((comment) => ({
                      id: comment.id,
                      body: comment.body,
                      ...authorOf(comment),
                    })),
                  })),
                  changesRequested: node.latestOpinionatedReviews.nodes
                    .filter(({ state }) => state === "CHANGES_REQUESTED")
                    .map((review) => ({ reviewId: review.id, ...authorOf(review) })),
                },
              },
            ] as const,
          ],
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
    head: node.headRefOid,
    headBranch: node.isCrossRepository ? null : node.headRefName,
    viewerIsAuthor: node.viewerDidAuthor,
    viewerHasDrafts: (node.pendingReviews.nodes[0]?.comments.totalCount ?? 0) > 0,
    viewerHasSubmittedReview: node.viewerSubmittedReviews.nodes.length > 0,
    reviewRequests: toReviewRequestsPage(node.reviewRequests),
  })),
  nextCursor: page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null,
})

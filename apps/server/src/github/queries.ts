import { Schema } from "effect"
import { GitHubAuthor } from "./author"
import { AddedDraft, DraftState } from "./drafts"
import { ThreadResolution } from "./discussions"
import { AddedReply } from "./replies"
import { PULL_REQUEST_STATUS_FIELDS, PullRequestStatusFields } from "./pullRequestStatus"
import {
  RepositoryPullRequestsData,
  SearchPullRequestsData,
  PullRequestChecksData,
  ReviewRequestsConnection,
} from "./repositoryPullRequests"

/** GitHub can return GraphQL errors with HTTP 200. */
export interface GraphQLBody<Data> {
  readonly data?: Data | null | undefined
  readonly errors?: ReadonlyArray<GraphQLError> | undefined
}

export interface GraphQLError {
  readonly type?: string | undefined
  readonly message: string
}

const GraphQLResponse = <A extends Schema.Top>(data: A) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(
      Schema.Array(Schema.Struct({ type: Schema.optional(Schema.String), message: Schema.String })),
    ),
  })

export const PULL_REQUEST_QUERY = `query PullRequest($owner: String!, $name: String!, $number: Int!) {
  viewer { login avatarUrl(size: 48) }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id
      repository { owner { login } name }
      number
      url
      title
      author { login }
      baseRefName
      headRefName
      baseRefOid
      headRefOid
      updatedAt
      state
      isDraft
      bodyHTML
      viewerDidAuthor
      ${PULL_REQUEST_STATUS_FIELDS}
    }
  }
}`

export const PULL_REQUEST_REVISION_QUERY = `query PullRequestRevision($id: ID!) {
  node(id: $id) {
    ... on PullRequest { baseRefOid headRefOid updatedAt reviews(states: PENDING, first: 1) { nodes { id } } }
  }
}`

export const TOUR_INPUT_QUERY = `query TourInput($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id title body baseRefOid headRefOid }
  }
}`

export const TourInputResponse = GraphQLResponse(
  Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        pullRequest: Schema.NullOr(
          Schema.Struct({
            id: Schema.String,
            title: Schema.String,
            body: Schema.String,
            baseRefOid: Schema.String,
            headRefOid: Schema.String,
          }),
        ),
      }),
    ),
  }),
)

export const FILE_CONTENTS_QUERY = `query FileContents($owner: String!, $name: String!, $expression: String!) {
  repository(owner: $owner, name: $name) {
    object(expression: $expression) {
      __typename
      ... on Blob { isBinary isTruncated text }
    }
  }
}`

export const GitHubPullRequestState = Schema.Literals(["OPEN", "CLOSED", "MERGED"])

export const ConnectionPageResponse = <A extends Schema.Top>(node: A) =>
  GraphQLResponse(
    Schema.Struct({
      node: Schema.NullOr(
        Schema.Struct({
          connection: Schema.Struct({
            pageInfo: Schema.Struct({
              hasNextPage: Schema.Boolean,
              endCursor: Schema.NullOr(Schema.String),
            }),
            nodes: Schema.Array(node),
          }),
        }),
      ),
    }),
  )

const PullRequestData = Schema.Struct({
  viewer: Schema.Struct({ login: Schema.String, avatarUrl: Schema.String }),
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          repository: Schema.Struct({
            owner: Schema.Struct({ login: Schema.String }),
            name: Schema.String,
          }),
          number: Schema.Number,
          url: Schema.String,
          title: Schema.String,
          author: GitHubAuthor,
          baseRefName: Schema.String,
          headRefName: Schema.String,
          baseRefOid: Schema.String,
          headRefOid: Schema.String,
          updatedAt: Schema.DateTimeUtcFromString,
          state: GitHubPullRequestState,
          isDraft: Schema.Boolean,
          bodyHTML: Schema.String,
          viewerDidAuthor: Schema.Boolean,
          ...PullRequestStatusFields,
        }),
      ),
    }),
  ),
})

export const PullRequestResponse = GraphQLResponse(PullRequestData)

export const PullRequestRevisionResponse = GraphQLResponse(
  Schema.Struct({
    node: Schema.NullOr(
      Schema.Struct({
        baseRefOid: Schema.String,
        headRefOid: Schema.String,
        updatedAt: Schema.DateTimeUtcFromString,
        reviews: Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String })) }),
      }),
    ),
  }),
)

export const FileContentsResponse = GraphQLResponse(
  Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        object: Schema.NullOr(
          Schema.Union([
            Schema.Struct({
              __typename: Schema.Literal("Blob"),
              isBinary: Schema.NullOr(Schema.Boolean),
              isTruncated: Schema.Boolean,
              text: Schema.NullOr(Schema.String),
            }),
            Schema.Struct({ __typename: Schema.Literals(["Tree", "Commit", "Tag"]) }),
          ]),
        ),
      }),
    ),
  }),
)

export const RepositoryPullRequestsResponse = GraphQLResponse(RepositoryPullRequestsData)

export const SearchPullRequestsResponse = GraphQLResponse(SearchPullRequestsData)

export const PullRequestChecksResponse = GraphQLResponse(PullRequestChecksData)

export const ReviewRequestsResponse = GraphQLResponse(
  Schema.Struct({
    node: Schema.NullOr(Schema.Struct({ connection: ReviewRequestsConnection })),
  }),
)

export const AddDraftResponse = GraphQLResponse(AddedDraft)

export const DraftStateResponse = GraphQLResponse(DraftState)

export const AddReplyResponse = GraphQLResponse(AddedReply)

export const ThreadResolutionResponse = GraphQLResponse(ThreadResolution)

export const MutationResponse = GraphQLResponse(Schema.Record(Schema.String, Schema.Unknown))

export const REPOSITORY_BRANCHES_QUERY = `query RepositoryBranches($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { name }
    refs(refPrefix: "refs/heads/", first: 100, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { name }
    }
  }
}`

export const RepositoryBranchesResponse = GraphQLResponse(
  Schema.Struct({
    repository: Schema.NullOr(
      Schema.Struct({
        defaultBranchRef: Schema.NullOr(Schema.Struct({ name: Schema.String })),
        refs: Schema.Struct({
          pageInfo: Schema.Struct({
            hasNextPage: Schema.Boolean,
            endCursor: Schema.NullOr(Schema.String),
          }),
          nodes: Schema.Array(Schema.Struct({ name: Schema.String })),
        }),
      }),
    ),
  }),
)

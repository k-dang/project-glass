import { Schema } from "effect"

export const VIEWED_FILES_QUERY = `query PullRequestViewedFiles($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequest {
      connection: files(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { path viewerViewedState }
      }
    }
  }
}`

export const GitHubViewedFile = Schema.Struct({
  path: Schema.String,
  viewerViewedState: Schema.Literals(["VIEWED", "UNVIEWED", "DISMISSED"]),
})

// GitHub takes a path, but no expected commit; callers check the Revision before writing.
export const MARK_FILE_VIEWED_MUTATION = `mutation MarkFileAsViewed($pullRequestId: ID!, $path: String!) {
  markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`

export const UNMARK_FILE_VIEWED_MUTATION = `mutation UnmarkFileAsViewed($pullRequestId: ID!, $path: String!) {
  unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`

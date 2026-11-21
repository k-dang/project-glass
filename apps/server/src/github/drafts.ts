import { type ChangedFile, Draft, FlaggedPlace, LinePlace } from "@glass/contracts"
import { Schema } from "effect"
import { fromGitHubSide, GitHubDiffSide } from "./diffSide"
import { type GitHubReviewThread, isOnLine, textDiffPaths } from "./comments"

export const ADD_DRAFT_MUTATION = `mutation AddPullRequestReviewThread($pullRequestId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestId: $pullRequestId, path: $path, line: $line, side: $side, body: $body }) {
    thread { path line diffSide comments(first: 1) { nodes { id body } } }
  }
}`

// WARNING: GitHub's update and delete mutations also act on published comments.
export const DRAFT_STATE_QUERY = `query DraftState($id: ID!) {
  node(id: $id) { ... on PullRequestReviewComment { state } }
}`

export const DraftState = Schema.Struct({
  node: Schema.NullOr(Schema.Struct({ state: Schema.optional(Schema.String) })),
})

export const UPDATE_DRAFT_MUTATION = `mutation UpdatePullRequestReviewComment($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $id, body: $body }) { clientMutationId }
}`

export const DELETE_COMMENT_MUTATION = `mutation DeletePullRequestReviewComment($id: ID!) {
  deletePullRequestReviewComment(input: { id: $id }) { clientMutationId }
}`

export const AddedDraft = Schema.Struct({
  addPullRequestReviewThread: Schema.NullOr(
    Schema.Struct({
      thread: Schema.NullOr(
        Schema.Struct({
          path: Schema.String,
          line: Schema.NullOr(Schema.Int),
          diffSide: GitHubDiffSide,
          comments: Schema.Struct({
            nodes: Schema.Array(Schema.Struct({ id: Schema.String, body: Schema.String })),
          }),
        }),
      ),
    }),
  ),
})

export const toDrafts = (
  files: ReadonlyArray<ChangedFile>,
  reviewThreads: ReadonlyArray<typeof GitHubReviewThread.Type>,
) => {
  const shown = textDiffPaths(files)
  const drafts: Array<Draft> = []

  for (const reviewThread of reviewThreads) {
    const { path } = reviewThread
    const onLine = isOnLine(reviewThread, shown)

    for (const { id, body, state, diffHunk } of reviewThread.comments.nodes) {
      if (state !== "PENDING") continue

      const place = onLine
        ? LinePlace.make({ side: fromGitHubSide(reviewThread.diffSide), line: reviewThread.line })
        : FlaggedPlace.make({
            originalLine:
              reviewThread.subjectType === "FILE" || reviewThread.originalLine === null
                ? "whole-file"
                : reviewThread.originalLine,
            diffHunk,
          })

      drafts.push(new Draft({ id, path, place, body }))
    }
  }

  return drafts
}

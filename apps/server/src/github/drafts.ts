import { type ChangedFile, Draft, FlaggedPlace, LinePlace } from "@glass/contracts"
import { Schema } from "effect"
import { fromGitHubSide, GitHubDiffSide } from "./diffSide"
import { type GitHubReviewThread, isOnLine, textDiffPaths } from "./discussions"

export const ADD_DRAFT_MUTATION = `mutation AddPullRequestReviewThread($pullRequestId: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestId: $pullRequestId, path: $path, line: $line, side: $side, body: $body }) {
    thread { path line diffSide comments(first: 1) { nodes { id body } } }
  }
}`

/** GitHub's update/delete mutations also act on published comments. */
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
  threads: ReadonlyArray<typeof GitHubReviewThread.Type>,
) => {
  const shown = textDiffPaths(files)
  const drafts: Array<Draft> = []

  for (const thread of threads) {
    const { path } = thread
    const onLine = isOnLine(thread, shown)

    for (const { id, body, state, diffHunk } of thread.comments.nodes) {
      if (state !== "PENDING") continue

      const place = onLine
        ? LinePlace.make({ side: fromGitHubSide(thread.diffSide), line: thread.line })
        : FlaggedPlace.make({
            originalLine:
              thread.subjectType === "FILE" || thread.originalLine === null
                ? "whole-file"
                : thread.originalLine,
            diffHunk,
          })

      drafts.push(new Draft({ id, path, place, body }))
    }
  }

  return drafts
}

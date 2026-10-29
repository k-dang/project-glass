import { Schema } from "effect"
import { GitHubComment } from "./discussions"

export const REPLY_MUTATION = `mutation AddPullRequestReviewThreadReply($pullRequestReviewThreadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $pullRequestReviewThreadId, body: $body }) {
    comment { id author { login avatarUrl(size: 48) } bodyHTML createdAt state }
  }
}`

export const AddedReply = Schema.Struct({
  addPullRequestReviewThreadReply: Schema.NullOr(
    Schema.Struct({
      comment: Schema.NullOr(
        Schema.Struct({
          ...GitHubComment.fields,
          state: Schema.Literals(["PENDING", "SUBMITTED"]),
        }),
      ),
    }),
  ),
})

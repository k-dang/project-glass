import type { ReviewDecision } from "@glass/contracts"

// WARNING: Submitting a pending review has no Revision precondition, and outdated Drafts can keep their original commit.
export const SUBMIT_REVIEW_MUTATION = `mutation SubmitPullRequestReview($pullRequestReviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId, event: $event, body: $body }) { clientMutationId }
}`

export const ADD_REVIEW_MUTATION = `mutation AddPullRequestReview($pullRequestId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $pullRequestId, event: $event, body: $body }) { clientMutationId }
}`

export const reviewEvents: Record<ReviewDecision, "COMMENT" | "APPROVE" | "REQUEST_CHANGES"> = {
  comment: "COMMENT",
  approve: "APPROVE",
  "request-changes": "REQUEST_CHANGES",
}

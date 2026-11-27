import { Schema } from "effect"
import { PullRequestRef } from "./pullRequest"
import type { SubscriptionReason } from "./subscription"

export const FailingCheck = Schema.Struct({
  name: Schema.String,
  url: Schema.NullOr(Schema.String),
})

export type FailingCheck = typeof FailingCheck.Type

export const FailingChecksReason = Schema.TaggedStruct("FailingChecks", {
  head: Schema.String,
  checks: Schema.NonEmptyArray(FailingCheck),
})

export const ReviewThreadComment = Schema.Struct({
  id: Schema.String,
  author: Schema.String,
  body: Schema.String,
})

export const WaitingReviewThread = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  line: Schema.NullOr(Schema.Int),
  comments: Schema.NonEmptyArray(ReviewThreadComment),
})

export type WaitingReviewThread = typeof WaitingReviewThread.Type

export const ReviewFeedbackReason = Schema.TaggedStruct("ReviewFeedback", {
  reviewThreads: Schema.NonEmptyArray(WaitingReviewThread),
})

export const ChangesRequestedReason = Schema.TaggedStruct("ChangesRequested", {
  reviewers: Schema.NonEmptyArray(Schema.String),
})

export const MergeConflictReason = Schema.TaggedStruct("MergeConflict", {
  base: Schema.String,
})

export const MergedReason = Schema.TaggedStruct("Merged", {})

export const ClosedReason = Schema.TaggedStruct("Closed", {})

export const PullRequestUpdateReason = Schema.Union([
  FailingChecksReason,
  ReviewFeedbackReason,
  ChangesRequestedReason,
  MergeConflictReason,
  MergedReason,
  ClosedReason,
])

export type PullRequestUpdateReason = typeof PullRequestUpdateReason.Type

export const subscriptionReasonOf: Record<PullRequestUpdateReason["_tag"], SubscriptionReason> = {
  FailingChecks: "failing-checks",
  ReviewFeedback: "review-feedback",
  ChangesRequested: "changes-requested",
  MergeConflict: "merge-conflict",
  Merged: "merged-or-closed",
  Closed: "merged-or-closed",
}

export const UpdatedPullRequest = Schema.Struct({
  subscriptionId: Schema.String,
  pullRequest: PullRequestRef,
  own: Schema.Boolean,
  reasons: Schema.NonEmptyArray(PullRequestUpdateReason),
  note: Schema.String,
})

export type UpdatedPullRequest = typeof UpdatedPullRequest.Type

export const PullRequestUpdate = Schema.TaggedStruct("Update", {
  source: Schema.Literal("github"),
  subjects: Schema.NonEmptyArray(UpdatedPullRequest),
  note: Schema.String,
})

export type PullRequestUpdate = typeof PullRequestUpdate.Type

export const Update = Schema.Union([PullRequestUpdate])

export type Update = typeof Update.Type

export const PullRequestUpdateNote = Schema.Trimmed.check(Schema.isNonEmpty())

export const defaultPullRequestUpdateNote = [
  "Fix the failing checks.",
  "Address the review feedback, then reply to and resolve each Review thread you handled.",
  "Rebase when the PR has a merge conflict.",
  "Change only this Thread's own PR unless the user asked otherwise.",
  "Never merge a PR.",
].join("\n")

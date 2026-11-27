import {
  ChangesRequestedReason,
  type Check,
  type Checks,
  ClosedReason,
  FailingChecksReason,
  MergeConflictReason,
  MergedReason,
  type PullRequestEnding,
  type PullRequestUpdateReason,
  ReviewFeedbackReason,
  type WaitingReviewThread,
} from "@glass/contracts"
import { Array as Arr, Result } from "effect"
import type { SubscribedDetails } from "./github/repositoryPullRequests"
import type { ReasonNow, SubjectNow } from "./updateDecision"

export type EndedState = PullRequestEnding["state"]

interface Open {
  readonly checks: Checks
  readonly failingChecks: ReadonlyArray<Check>
  readonly mergeConflict: boolean | null
  readonly details: SubscribedDetails
}

type Stands = ReasonNow<PullRequestUpdateReason>

const failingChecks = ({ checks: rollup, failingChecks: failing, details }: Open): Stands => {
  const checks = failing.map(({ name, url }) => ({ name, url }))

  if (!Arr.isReadonlyArrayNonEmpty(checks))
    return rollup === "running" || rollup === "unavailable"
      ? { state: "unsettled", seen: [] }
      : { state: "cleared" }

  return {
    state: "holds",
    seen: checks.map(
      ({ name, url }) => `${details.head}
${name}
${url ?? ""}`,
    ),
    detail: FailingChecksReason.make({ head: details.head, checks }),
  }
}

export const partitionFeedback = ({ reviewThreads, changesRequested }: SubscribedDetails) => {
  const [allowedThreads, heldBackThreads] = Arr.partition(reviewThreads, (reviewThread) => {
    const waiting = reviewThread.comments.at(-1)

    return waiting?.hasWriteAccess === true
      ? Result.succeed({ reviewThread, waiting: waiting.id })
      : Result.fail(reviewThread)
  })

  const [allowedReviews, heldBackReviews] = Arr.partition(changesRequested, (review) =>
    review.hasWriteAccess ? Result.succeed(review) : Result.fail(review),
  )

  return {
    allowed: { reviewThreads: allowedThreads, changesRequested: allowedReviews },
    heldBack: { reviewThreads: heldBackThreads, changesRequested: heldBackReviews },
  }
}

const reviewFeedback = ({ details }: Open): Stands => {
  const allowed = partitionFeedback(details).allowed.reviewThreads

  const reviewThreads = allowed.flatMap(({ reviewThread: { id, path, line, comments } }) => {
    const written = comments.flatMap(({ hasWriteAccess, ...comment }) =>
      hasWriteAccess ? [comment] : [],
    )

    return Arr.isReadonlyArrayNonEmpty(written)
      ? [{ id, path, line, comments: written } satisfies WaitingReviewThread]
      : []
  })

  return Arr.isReadonlyArrayNonEmpty(reviewThreads)
    ? {
        state: "holds",
        seen: allowed.map(({ waiting }) => waiting),
        detail: ReviewFeedbackReason.make({ reviewThreads }),
      }
    : { state: "cleared" }
}

const changesRequested = ({ details }: Open): Stands => {
  const allowed = partitionFeedback(details).allowed.changesRequested
  const reviewers = Arr.dedupe(allowed.map(({ author }) => author))

  return Arr.isReadonlyArrayNonEmpty(reviewers)
    ? {
        state: "holds",
        seen: allowed.map(({ reviewId }) => reviewId),
        detail: ChangesRequestedReason.make({ reviewers }),
      }
    : { state: "cleared" }
}

const mergeConflict = (
  { mergeConflict: conflict, details }: Open,
  seen: ReadonlyArray<string>,
): Stands => {
  if (conflict === null) return { state: "unsettled", seen }

  return conflict
    ? {
        state: "holds",
        seen: [details.base],
        detail: MergeConflictReason.make({ base: details.base }),
      }
    : { state: "cleared" }
}

export const ENDING_TOLD_BY = "merged-or-closed"

export const endedNow = (state: EndedState): SubjectNow<PullRequestUpdateReason> => ({
  state: "ended",
  toldBy: ENDING_TOLD_BY,
  detail: state === "merged" ? MergedReason.make({}) : ClosedReason.make({}),
})

export const openNow = (open: Open): SubjectNow<PullRequestUpdateReason> => ({
  state: "open",
  reasons: [
    { reason: "failing-checks", stands: () => failingChecks(open) },
    { reason: "review-feedback", stands: () => reviewFeedback(open) },
    { reason: "changes-requested", stands: () => changesRequested(open) },
    { reason: "merge-conflict", stands: (seen) => mergeConflict(open, seen) },
  ],
})

import {
  ChangesRequestedEvent,
  ChecksFailedEvent,
  ChecksPassedEvent,
  type Event,
  MergeConflictAppearedEvent,
  MergeConflictClearedEvent,
  PullRequestClosedEvent,
  PullRequestMergedEvent,
  referenceKey,
  ReviewFeedbackWaitingEvent,
} from "@glass/contracts"
import { Match } from "effect"
import type { EndedPullRequest } from "./github/branchPullRequests"
import type { Mirror, MirroredPullRequest } from "./PullRequestMirror"

const changesOf = (before: MirroredPullRequest, after: MirroredPullRequest): Array<Event> => {
  const pullRequest = after.ref
  const events: Array<Event> = []

  const checksChanged =
    before.head !== after.head ||
    (before.checks !== "unavailable" && before.checks !== after.checks)

  if (checksChanged && after.checks === "failing")
    events.push(ChecksFailedEvent.make({ pullRequest, head: after.head }))

  if (checksChanged && after.checks === "passing")
    events.push(ChecksPassedEvent.make({ pullRequest, head: after.head }))

  if (before.attention === null || after.attention === null) return events

  if (after.attention.awaitingReply > before.attention.awaitingReply)
    events.push(
      ReviewFeedbackWaitingEvent.make({
        pullRequest,
        reviewThreads: after.attention.awaitingReply,
      }),
    )

  if (after.attention.changesRequested && !before.attention.changesRequested)
    events.push(ChangesRequestedEvent.make({ pullRequest }))

  if (
    before.attention.mergeConflict !== null &&
    after.attention.mergeConflict !== null &&
    before.attention.mergeConflict !== after.attention.mergeConflict
  )
    events.push(
      after.attention.mergeConflict
        ? MergeConflictAppearedEvent.make({ pullRequest })
        : MergeConflictClearedEvent.make({ pullRequest }),
    )

  return events
}

const pullRequestsOf = (mirror: Mirror) =>
  mirror.repositories.flatMap(({ pullRequests }) => pullRequests)

export const eventsBetween = (before: Mirror | undefined, after: Mirror): ReadonlyArray<Event> => {
  if (before === undefined) return []

  const known = new Map(pullRequestsOf(before).map((pr) => [pr.id, pr]))

  return pullRequestsOf(after).flatMap((pr) => {
    const was = known.get(pr.id)

    return was === undefined ? [] : changesOf(was, pr)
  })
}

export const endedEvents = (
  before: Mirror | undefined,
  ended: ReadonlyArray<EndedPullRequest>,
): ReadonlyArray<Event> => {
  if (before === undefined) return []

  const open = new Set(pullRequestsOf(before).map((pr) => referenceKey(pr.ref)))

  return ended.flatMap(({ ref: pullRequest, state }) => {
    if (!open.has(referenceKey(pullRequest))) return []

    return [
      Match.valueTags(state, {
        Merged: ({ mergedAt }) => PullRequestMergedEvent.make({ pullRequest, mergedAt }),
        Closed: () => PullRequestClosedEvent.make({ pullRequest }),
      }),
    ]
  })
}

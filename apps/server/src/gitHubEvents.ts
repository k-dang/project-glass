import {
  ChangesRequestedEvent,
  ChecksFailedEvent,
  ChecksPassedEvent,
  type Event,
  MergeConflictClearedEvent,
  MergeConflictEvent,
  PullRequestClosedEvent,
  PullRequestMergedEvent,
  type PullRequestRef,
  referenceKey,
  ReviewFeedbackEvent,
  type WaitingReviewThread,
} from "@glass/contracts"
import { Array as Arr, DateTime, Predicate } from "effect"
import type { NewEvent } from "./EventLog"
import type { SubscribedDetails } from "./github/repositoryPullRequests"
import type { Mirror, MirroredPullRequest } from "./PullRequestMirror"

export type EndedState = "merged" | "closed"

type Detailed = MirroredPullRequest & { readonly details: SubscribedDetails }

const isDetailed = (pr: MirroredPullRequest): pr is Detailed => pr.details !== null

export const heldBackFeedback = ({ reviewThreads, changesRequested }: SubscribedDetails) => ({
  reviewThreads: reviewThreads.filter(({ comments }) => comments.at(-1)?.hasWriteAccess !== true),
  changesRequested: changesRequested.filter(({ hasWriteAccess }) => !hasWriteAccess),
})

const checksEvents = (was: Detailed | undefined, now: Detailed): ReadonlyArray<Event> => {
  const pullRequest = now.ref
  const moved = was === undefined || was.head !== now.head || was.checks !== now.checks

  if (!moved) return []

  const checks = (now.attention?.failingChecks ?? []).map(({ name, url }) => ({ name, url }))

  if (now.checks === "failing" && Arr.isReadonlyArrayNonEmpty(checks))
    return [ChecksFailedEvent.make({ pullRequest, head: now.head, checks })]

  return was !== undefined && now.checks === "passing"
    ? [ChecksPassedEvent.make({ pullRequest, head: now.head })]
    : []
}

const reviewFeedbackEvents = (was: Detailed | undefined, now: Detailed): ReadonlyArray<Event> => {
  const waitedBefore = new Set(
    (was?.details.reviewThreads ?? []).flatMap(({ comments }) => comments.at(-1)?.id ?? []),
  )

  const reviewThreads = now.details.reviewThreads.flatMap(
    ({ id, path, line, comments }): ReadonlyArray<WaitingReviewThread> => {
      const waiting = comments.at(-1)

      if (waiting?.hasWriteAccess !== true || waitedBefore.has(waiting.id)) return []

      const written = comments.flatMap(({ hasWriteAccess, ...comment }) =>
        hasWriteAccess ? [comment] : [],
      )

      return Arr.isReadonlyArrayNonEmpty(written) ? [{ id, path, line, comments: written }] : []
    },
  )

  return Arr.isReadonlyArrayNonEmpty(reviewThreads)
    ? [ReviewFeedbackEvent.make({ pullRequest: now.ref, reviewThreads })]
    : []
}

const changesRequestedEvents = (was: Detailed | undefined, now: Detailed): ReadonlyArray<Event> => {
  const requestedBefore = new Set(
    (was?.details.changesRequested ?? []).map(({ reviewId }) => reviewId),
  )

  const reviewers = Arr.dedupe(
    now.details.changesRequested.flatMap(({ reviewId, author, hasWriteAccess }) =>
      hasWriteAccess && !requestedBefore.has(reviewId) ? [author] : [],
    ),
  )

  return Arr.isReadonlyArrayNonEmpty(reviewers)
    ? [ChangesRequestedEvent.make({ pullRequest: now.ref, reviewers })]
    : []
}

const mergeConflictEvents = (was: Detailed | undefined, now: Detailed): ReadonlyArray<Event> => {
  const before = was?.details.mergeConflict ?? null
  const after = now.details.mergeConflict

  if (after === true && before !== true)
    return [MergeConflictEvent.make({ pullRequest: now.ref, base: now.details.base })]

  return after === false && before === true
    ? [MergeConflictClearedEvent.make({ pullRequest: now.ref })]
    : []
}

const changesOf = (was: Detailed | undefined, now: Detailed) => [
  ...checksEvents(was, now),
  ...reviewFeedbackEvents(was, now),
  ...changesRequestedEvents(was, now),
  ...mergeConflictEvents(was, now),
]

export const standingEvents = (pr: MirroredPullRequest): ReadonlyArray<Event> | null =>
  isDetailed(pr) ? changesOf(undefined, pr) : null

const pullRequestsOf = (mirror: Mirror) =>
  mirror.repositories.flatMap(({ pullRequests }) => pullRequests)

export const eventsBetween = (before: Mirror | undefined, after: Mirror): ReadonlyArray<Event> => {
  const known = new Map(
    (before === undefined ? [] : pullRequestsOf(before)).flatMap((pr) =>
      isDetailed(pr) ? [[pr.id, pr] as const] : [],
    ),
  )

  return pullRequestsOf(after).flatMap((pr) =>
    isDetailed(pr) ? changesOf(known.get(pr.id), pr) : [],
  )
}

export const endedEvent = (
  pullRequest: PullRequestRef,
  state: EndedState,
  at: DateTime.Utc,
): Event =>
  state === "merged"
    ? PullRequestMergedEvent.make({ pullRequest, mergedAt: at })
    : PullRequestClosedEvent.make({ pullRequest, closedAt: at })

const endedAt = (event: Event) => {
  if (Predicate.isTagged(event, "PullRequestMerged")) return event.mergedAt

  return Predicate.isTagged(event, "PullRequestClosed") ? event.closedAt : undefined
}

export const recorded = (events: ReadonlyArray<Event>) =>
  events.map((event): NewEvent => {
    const subject = referenceKey(event.pullRequest)
    const at = endedAt(event)

    return at === undefined
      ? { event, subject }
      : { event, subject, once: `${event._tag} ${subject} ${DateTime.formatIso(at)}` }
  })

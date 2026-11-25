import {
  ChangesRequestedReason,
  type Check,
  type Checks,
  ClosedReason,
  FailingChecksReason,
  MergeConflictReason,
  MergedReason,
  type PullRequestUpdateReason,
  ReviewFeedbackReason,
  type SubscriptionReason,
  type WaitingReviewThread,
} from "@glass/contracts"
import { Array as Arr, Data, Predicate, Schema } from "effect"
import type { SubscribedRead } from "./github/repositoryPullRequests"

export const GIVES_UP_AFTER = 3

const Updates = Schema.Struct({
  "failing-checks": Schema.Int,
  "review-feedback": Schema.Int,
  "changes-requested": Schema.Int,
  "merge-conflict": Schema.Int,
})

type OpenReason = keyof typeof Updates.Type

const noUpdates: typeof Updates.Type = {
  "failing-checks": 0,
  "review-feedback": 0,
  "changes-requested": 0,
  "merge-conflict": 0,
}

export const Told = Schema.Struct({
  failedRuns: Schema.NullOr(
    Schema.Struct({ head: Schema.String, runs: Schema.Array(Schema.String) }),
  ),
  reviewComments: Schema.Array(Schema.String),
  changesRequested: Schema.Array(Schema.String),
  conflictBase: Schema.NullOr(Schema.String),
  updates: Updates,
})

export type Told = typeof Told.Type

export const nothingTold: Told = {
  failedRuns: null,
  reviewComments: [],
  changesRequested: [],
  conflictBase: null,
  updates: noUpdates,
}

export const countedAfresh = (told: Told): Told => ({ ...told, updates: noUpdates })

export const sameTold = Schema.toEquivalence(Told)

export type PullRequestNow = Data.TaggedEnum<{
  Open: {
    readonly checks: Checks
    readonly failingChecks: ReadonlyArray<Check>
    readonly mergeConflict: boolean | null
    readonly read: SubscribedRead
  }
  Ended: { readonly state: "merged" | "closed" }
}>

export const PullRequestNow = Data.taggedEnum<PullRequestNow>()

export interface Decision {
  readonly reasons: ReadonlyArray<PullRequestUpdateReason>
  readonly told: Told
}

type Kept = Exclude<keyof Told, "updates">

interface Part<Key extends Kept> {
  readonly told: Told[Key]
  readonly reason: PullRequestUpdateReason | null
  readonly cleared: boolean
}

type Open = Extract<PullRequestNow, { _tag: "Open" }>

const runOf = ({ name, url }: Pick<Check, "name" | "url">) => `${name}\n${url ?? ""}`

const failingChecks = (
  { checks: rollup, failingChecks: failing, read }: Open,
  told: Told,
): Part<"failedRuns"> => {
  const checks = failing.map(({ name, url }) => ({ name, url }))

  if (!Arr.isReadonlyArrayNonEmpty(checks))
    return { told: null, reason: null, cleared: rollup !== "running" }

  const runs = checks.map(runOf)
  const before = told.failedRuns

  const another =
    before === null || before.head !== read.head || runs.some((run) => !before.runs.includes(run))

  return {
    told: { head: read.head, runs },
    reason: another ? FailingChecksReason.make({ head: read.head, checks }) : null,
    cleared: false,
  }
}

const allowedThreads = ({ read }: Open) =>
  read.reviewThreads.flatMap(({ id, path, line, comments }) => {
    const waiting = comments.at(-1)

    const allowed = comments.flatMap(({ hasWriteAccess, ...comment }) =>
      hasWriteAccess ? [comment] : [],
    )

    return waiting?.hasWriteAccess === true && Arr.isReadonlyArrayNonEmpty(allowed)
      ? [
          {
            waiting: waiting.id,
            reviewThread: { id, path, line, comments: allowed } satisfies WaitingReviewThread,
          },
        ]
      : []
  })

const reviewFeedback = (now: Open, told: Told): Part<"reviewComments"> => {
  const allowed = allowedThreads(now)
  const waiting = allowed.map((thread) => thread.waiting)
  const reviewThreads = allowed.map((thread) => thread.reviewThread)

  return {
    told: waiting,
    reason:
      Arr.isReadonlyArrayNonEmpty(reviewThreads) &&
      waiting.some((comment) => !told.reviewComments.includes(comment))
        ? ReviewFeedbackReason.make({ reviewThreads })
        : null,
    cleared: reviewThreads.length === 0,
  }
}

const changesRequested = ({ read }: Open, told: Told): Part<"changesRequested"> => {
  const allowed = read.changesRequested.filter(({ hasWriteAccess }) => hasWriteAccess)
  const reviews = allowed.map(({ reviewId }) => reviewId)
  const reviewers = Arr.dedupe(allowed.map(({ author }) => author))

  return {
    told: reviews,
    reason:
      Arr.isReadonlyArrayNonEmpty(reviewers) &&
      reviews.some((review) => !told.changesRequested.includes(review))
        ? ChangesRequestedReason.make({ reviewers })
        : null,
    cleared: reviewers.length === 0,
  }
}

const mergeConflict = (
  { mergeConflict: conflict, read }: Open,
  told: Told,
): Part<"conflictBase"> => {
  if (conflict === null) return { told: told.conflictBase, reason: null, cleared: false }

  if (!conflict) return { told: null, reason: null, cleared: true }

  return {
    told: read.base,
    reason: told.conflictBase === read.base ? null : MergeConflictReason.make({ base: read.base }),
    cleared: false,
  }
}

export const decide = (
  covered: ReadonlyArray<SubscriptionReason>,
  now: PullRequestNow,
  told: Told,
): Decision => {
  if (Predicate.isTagged(now, "Ended"))
    return {
      told,
      reasons: covered.includes("merged-or-closed")
        ? [now.state === "merged" ? MergedReason.make({}) : ClosedReason.make({})]
        : [],
    }

  const part = <Key extends Kept>(
    reason: OpenReason,
    key: Key,
    decided: (now: Open, told: Told) => Part<Key>,
  ) => {
    const updates = told.updates[reason]

    if (!covered.includes(reason)) return { told: told[key], reason: null, updates }

    const found = decided(now, told)

    if (found.reason === null)
      return { told: found.told, reason: null, updates: found.cleared ? 0 : updates }

    return updates >= GIVES_UP_AFTER
      ? { told: told[key], reason: null, updates }
      : { told: found.told, reason: found.reason, updates: updates + 1 }
  }

  const checks = part("failing-checks", "failedRuns", failingChecks)
  const feedback = part("review-feedback", "reviewComments", reviewFeedback)
  const requested = part("changes-requested", "changesRequested", changesRequested)
  const conflict = part("merge-conflict", "conflictBase", mergeConflict)

  return {
    told: {
      failedRuns: checks.told,
      reviewComments: feedback.told,
      changesRequested: requested.told,
      conflictBase: conflict.told,
      updates: {
        "failing-checks": checks.updates,
        "review-feedback": feedback.updates,
        "changes-requested": requested.updates,
        "merge-conflict": conflict.updates,
      },
    },
    reasons: [checks, feedback, requested, conflict].flatMap(({ reason }) =>
      reason === null ? [] : [reason],
    ),
  }
}

import {
  ChangesRequestedReason,
  type Check,
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

export const Told = Schema.Struct({
  failedRuns: Schema.NullOr(
    Schema.Struct({ head: Schema.String, runs: Schema.Array(Schema.String) }),
  ),
  reviewComments: Schema.Array(Schema.String),
  changesRequested: Schema.Array(Schema.String),
  conflictBase: Schema.NullOr(Schema.String),
})

export type Told = typeof Told.Type

export const nothingTold: Told = {
  failedRuns: null,
  reviewComments: [],
  changesRequested: [],
  conflictBase: null,
}

export const sameTold = Schema.toEquivalence(Told)

export type PullRequestNow = Data.TaggedEnum<{
  Open: {
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

interface Part<Key extends keyof Told> {
  readonly told: Told[Key]
  readonly reason: PullRequestUpdateReason | null
}

type Open = Extract<PullRequestNow, { _tag: "Open" }>

const runOf = ({ name, url }: Pick<Check, "name" | "url">) => `${name}\n${url ?? ""}`

const failingChecks = ({ failingChecks: failing, read }: Open, told: Told): Part<"failedRuns"> => {
  const checks = failing.map(({ name, url }) => ({ name, url }))

  if (!Arr.isReadonlyArrayNonEmpty(checks)) return { told: null, reason: null }

  const runs = checks.map(runOf)
  const before = told.failedRuns

  const another =
    before === null || before.head !== read.head || runs.some((run) => !before.runs.includes(run))

  return {
    told: { head: read.head, runs },
    reason: another ? FailingChecksReason.make({ head: read.head, checks }) : null,
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
  }
}

const mergeConflict = (
  { mergeConflict: conflict, read }: Open,
  told: Told,
): Part<"conflictBase"> => {
  if (conflict === null) return { told: told.conflictBase, reason: null }

  if (!conflict) return { told: null, reason: null }

  return {
    told: read.base,
    reason: told.conflictBase === read.base ? null : MergeConflictReason.make({ base: read.base }),
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

  const part = <Key extends keyof Told>(
    reason: SubscriptionReason,
    key: Key,
    decided: (now: Open, told: Told) => Part<Key>,
  ): Part<Key> =>
    covered.includes(reason) ? decided(now, told) : { told: told[key], reason: null }

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
    },
    reasons: [checks, feedback, requested, conflict].flatMap(({ reason }) =>
      reason === null ? [] : [reason],
    ),
  }
}

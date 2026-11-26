import {
  ChangesRequestedReason,
  type Check,
  type Checks,
  ClosedReason,
  FailingChecksReason,
  MergeConflictReason,
  MergedReason,
  type OpenReason,
  openReasons,
  type PullRequestUpdateReason,
  ReviewFeedbackReason,
  type SubscriptionReason,
  type WaitingReviewThread,
} from "@glass/contracts"
import { Array as Arr, Data, Predicate, Record, Result, Schema } from "effect"
import type { SubscribedDetails } from "./github/repositoryPullRequests"

const GIVES_UP_AFTER = 3

const ReasonTold = Schema.Struct({
  seen: Schema.Array(Schema.String),
  updates: Schema.Int,
})

type ReasonTold = typeof ReasonTold.Type

export const Told = Schema.Record(Schema.Literals(openReasons), ReasonTold)

export type Told = typeof Told.Type

const untold: ReasonTold = { seen: [], updates: 0 }

export const nothingTold: Told = {
  "failing-checks": untold,
  "review-feedback": untold,
  "changes-requested": untold,
  "merge-conflict": untold,
}

export const countedAfresh = (told: Told): Told =>
  Record.map(told, ({ seen }) => ({ seen, updates: 0 }))

export const sameTold = Schema.toEquivalence(Told)

export const EndedState = Schema.Literals(["merged", "closed"])

export type EndedState = typeof EndedState.Type

export type PullRequestNow = Data.TaggedEnum<{
  Open: {
    readonly checks: Checks
    readonly failingChecks: ReadonlyArray<Check>
    readonly mergeConflict: boolean | null
    readonly details: SubscribedDetails
  }
  Ended: { readonly state: EndedState }
}>

export const PullRequestNow = Data.taggedEnum<PullRequestNow>()

export type Standing = "due" | "gave-up" | "told"

export interface Decision {
  readonly reasons: ReadonlyArray<PullRequestUpdateReason>
  readonly told: Told
  readonly standing: Readonly<Record<OpenReason, Standing | null>>
}

type Open = Extract<PullRequestNow, { _tag: "Open" }>

type ReasonNow =
  | { readonly state: "cleared" }
  | { readonly state: "unsettled"; readonly seen: ReadonlyArray<string> }
  | {
      readonly state: "holds"
      readonly seen: ReadonlyArray<string>
      readonly reason: PullRequestUpdateReason
    }

const failingChecks = ({ checks: rollup, failingChecks: failing, details }: Open): ReasonNow => {
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
    reason: FailingChecksReason.make({ head: details.head, checks }),
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

const reviewFeedback = ({ details }: Open): ReasonNow => {
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
        reason: ReviewFeedbackReason.make({ reviewThreads }),
      }
    : { state: "cleared" }
}

const changesRequested = ({ details }: Open): ReasonNow => {
  const allowed = partitionFeedback(details).allowed.changesRequested
  const reviewers = Arr.dedupe(allowed.map(({ author }) => author))

  return Arr.isReadonlyArrayNonEmpty(reviewers)
    ? {
        state: "holds",
        seen: allowed.map(({ reviewId }) => reviewId),
        reason: ChangesRequestedReason.make({ reviewers }),
      }
    : { state: "cleared" }
}

const mergeConflict = (
  { mergeConflict: conflict, details }: Open,
  seen: ReadonlyArray<string>,
): ReasonNow => {
  if (conflict === null) return { state: "unsettled", seen }

  return conflict
    ? {
        state: "holds",
        seen: [details.base],
        reason: MergeConflictReason.make({ base: details.base }),
      }
    : { state: "cleared" }
}

const standsNow: Record<OpenReason, (now: Open, seen: ReadonlyArray<string>) => ReasonNow> = {
  "failing-checks": failingChecks,
  "review-feedback": reviewFeedback,
  "changes-requested": changesRequested,
  "merge-conflict": mergeConflict,
}

interface ReasonDecision {
  readonly told: ReasonTold
  readonly reason: PullRequestUpdateReason | null
  readonly standing: Standing | null
}

export const decide = (
  covered: ReadonlyArray<SubscriptionReason>,
  now: PullRequestNow,
  told: Told,
): Decision => {
  if (Predicate.isTagged(now, "Ended"))
    return {
      told,
      standing: Record.map(told, () => null),
      reasons: covered.includes("merged-or-closed")
        ? [now.state === "merged" ? MergedReason.make({}) : ClosedReason.make({})]
        : [],
    }

  const decided = Record.map(standsNow, (stands, reason): ReasonDecision => {
    const before = told[reason]

    if (!covered.includes(reason)) return { told: before, reason: null, standing: null }

    const found = stands(now, before.seen)

    if (found.state === "cleared") return { told: untold, reason: null, standing: null }

    const seen = { ...before, seen: found.seen }

    if (found.state === "unsettled") return { told: seen, reason: null, standing: null }

    if (found.seen.every((one) => before.seen.includes(one)))
      return { told: seen, reason: null, standing: "told" }

    return before.updates >= GIVES_UP_AFTER
      ? { told: before, reason: null, standing: "gave-up" }
      : {
          told: { seen: found.seen, updates: before.updates + 1 },
          reason: found.reason,
          standing: "due",
        }
  })

  return {
    told: Record.map(decided, (reason) => reason.told),
    reasons: openReasons.flatMap((open) => decided[open].reason ?? []),
    standing: Record.map(decided, ({ standing }) => standing),
  }
}

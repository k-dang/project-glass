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
import { Array as Arr, Data, Predicate, Record, Schema } from "effect"
import type { SubscribedDetails } from "./github/repositoryPullRequests"

const GIVES_UP_AFTER = 3

const Updates = Schema.Record(Schema.Literals(openReasons), Schema.Int)

const noUpdates = {
  "failing-checks": 0,
  "review-feedback": 0,
  "changes-requested": 0,
  "merge-conflict": 0,
} satisfies Record<OpenReason, number>

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

const nothingStanding: Decision["standing"] = Record.map(noUpdates, () => null)

type ToldKey = Exclude<keyof Told, "updates">

interface ReasonNow<Key extends ToldKey> {
  readonly told: Told[Key]
  readonly reason: PullRequestUpdateReason | null
  readonly state: "holds" | "cleared" | "unsettled"
}

interface ReasonDecision<Key extends ToldKey> {
  readonly told: Told[Key]
  readonly reason: PullRequestUpdateReason | null
  readonly updates: number
  readonly standing: Standing | null
}

type Open = Extract<PullRequestNow, { _tag: "Open" }>

const runOf = ({ name, url }: Pick<Check, "name" | "url">) => `${name}\n${url ?? ""}`

const failingChecks = (
  { checks: rollup, failingChecks: failing, details }: Open,
  told: Told,
): ReasonNow<"failedRuns"> => {
  const checks = failing.map(({ name, url }) => ({ name, url }))

  if (!Arr.isReadonlyArrayNonEmpty(checks))
    return {
      told: null,
      reason: null,
      state: rollup === "running" || rollup === "unavailable" ? "unsettled" : "cleared",
    }

  const runs = checks.map(runOf)
  const before = told.failedRuns

  const another =
    before === null ||
    before.head !== details.head ||
    runs.some((run) => !before.runs.includes(run))

  return {
    told: { head: details.head, runs },
    reason: another ? FailingChecksReason.make({ head: details.head, checks }) : null,
    state: "holds",
  }
}

const allowedThreads = ({ details }: Open) =>
  details.reviewThreads.flatMap(({ id, path, line, comments }) => {
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

export const feedbackHeldBack = ({
  reviewThreads,
  changesRequested: reviews,
}: SubscribedDetails) => ({
  reviewThreads: reviewThreads.filter(({ comments }) => comments.at(-1)?.hasWriteAccess !== true)
    .length,
  changesRequested: reviews.some(({ hasWriteAccess }) => !hasWriteAccess),
})

const reviewFeedback = (now: Open, told: Told): ReasonNow<"reviewComments"> => {
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
    state: reviewThreads.length === 0 ? "cleared" : "holds",
  }
}

const changesRequested = ({ details }: Open, told: Told): ReasonNow<"changesRequested"> => {
  const allowed = details.changesRequested.filter(({ hasWriteAccess }) => hasWriteAccess)
  const reviews = allowed.map(({ reviewId }) => reviewId)
  const reviewers = Arr.dedupe(allowed.map(({ author }) => author))

  return {
    told: reviews,
    reason:
      Arr.isReadonlyArrayNonEmpty(reviewers) &&
      reviews.some((review) => !told.changesRequested.includes(review))
        ? ChangesRequestedReason.make({ reviewers })
        : null,
    state: reviewers.length === 0 ? "cleared" : "holds",
  }
}

const mergeConflict = (
  { mergeConflict: conflict, details }: Open,
  told: Told,
): ReasonNow<"conflictBase"> => {
  if (conflict === null) return { told: told.conflictBase, reason: null, state: "unsettled" }

  if (!conflict) return { told: null, reason: null, state: "cleared" }

  return {
    told: details.base,
    reason:
      told.conflictBase === details.base ? null : MergeConflictReason.make({ base: details.base }),
    state: "holds",
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
      standing: nothingStanding,
      reasons: covered.includes("merged-or-closed")
        ? [now.state === "merged" ? MergedReason.make({}) : ClosedReason.make({})]
        : [],
    }

  const decideReason = <Key extends ToldKey>(
    reason: OpenReason,
    key: Key,
    standsNow: (now: Open, told: Told) => ReasonNow<Key>,
  ): ReasonDecision<Key> => {
    const updates = told.updates[reason]

    if (!covered.includes(reason)) return { told: told[key], reason: null, updates, standing: null }

    const found = standsNow(now, told)

    if (found.reason === null)
      return {
        told: found.told,
        reason: null,
        updates: found.state === "cleared" ? 0 : updates,
        standing: found.state === "holds" ? "told" : null,
      }

    return updates >= GIVES_UP_AFTER
      ? { told: told[key], reason: null, updates, standing: "gave-up" }
      : { told: found.told, reason: found.reason, updates: updates + 1, standing: "due" }
  }

  const decided = {
    "failing-checks": decideReason("failing-checks", "failedRuns", failingChecks),
    "review-feedback": decideReason("review-feedback", "reviewComments", reviewFeedback),
    "changes-requested": decideReason("changes-requested", "changesRequested", changesRequested),
    "merge-conflict": decideReason("merge-conflict", "conflictBase", mergeConflict),
  } satisfies Record<OpenReason, unknown>

  return {
    told: {
      failedRuns: decided["failing-checks"].told,
      reviewComments: decided["review-feedback"].told,
      changesRequested: decided["changes-requested"].told,
      conflictBase: decided["merge-conflict"].told,
      updates: Record.map(decided, ({ updates }) => updates),
    },
    reasons: openReasons.flatMap((open) => {
      const { reason } = decided[open]

      return reason === null ? [] : [reason]
    }),
    standing: Record.map(decided, ({ standing }) => standing),
  }
}

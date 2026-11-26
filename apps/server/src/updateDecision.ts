import type { SubscriptionReason } from "@glass/contracts"
import { Record, Schema } from "effect"

const GIVES_UP_AFTER = 3

const ReasonTold = Schema.Struct({
  seen: Schema.Array(Schema.String),
  updates: Schema.Int,
})

type ReasonTold = typeof ReasonTold.Type

export const Told = Schema.Record(Schema.String, ReasonTold)

export type Told = typeof Told.Type

const untold: ReasonTold = { seen: [], updates: 0 }

export const nothingTold: Told = {}

const withoutUntold = (told: Told): Told =>
  Record.filter(told, ({ seen, updates }) => seen.length > 0 || updates > 0)

export const countedAfresh = (told: Told): Told =>
  withoutUntold(Record.map(told, ({ seen }) => ({ seen, updates: 0 })))

export const sameTold = Schema.toEquivalence(Told)

export type ReasonNow<Detail> =
  | { readonly state: "cleared" }
  | { readonly state: "unsettled"; readonly seen: ReadonlyArray<string> }
  | { readonly state: "holds"; readonly seen: ReadonlyArray<string>; readonly detail: Detail }

export type SubjectNow<Detail> =
  | {
      readonly state: "open"
      readonly reasons: ReadonlyArray<{
        readonly reason: SubscriptionReason
        readonly stands: (seen: ReadonlyArray<string>) => ReasonNow<Detail>
      }>
    }
  | { readonly state: "ended"; readonly toldBy: SubscriptionReason; readonly detail: Detail }

export type Standing = "due" | "gave-up" | "told"

export interface Due<Detail> {
  readonly reason: SubscriptionReason
  readonly detail: Detail
}

export interface Decision<Detail> {
  readonly due: ReadonlyArray<Due<Detail>>
  readonly told: Told
  readonly standing: Readonly<Partial<Record<SubscriptionReason, Standing>>>
}

interface ReasonDecision<Detail> {
  readonly reason: SubscriptionReason
  readonly told: ReasonTold
  readonly due?: Due<Detail>
  readonly standing?: Standing
}

export const decide = <Detail>(
  covered: ReadonlyArray<SubscriptionReason>,
  now: SubjectNow<Detail>,
  told: Told,
): Decision<Detail> => {
  if (now.state === "ended")
    return {
      told,
      standing: {},
      due: covered.includes(now.toldBy) ? [{ reason: now.toldBy, detail: now.detail }] : [],
    }

  const decided = now.reasons.map(({ reason, stands }): ReasonDecision<Detail> => {
    const before = told[reason] ?? untold

    if (!covered.includes(reason)) return { reason, told: before }

    const found = stands(before.seen)

    if (found.state === "cleared") return { reason, told: untold }

    const seen = { ...before, seen: found.seen }

    if (found.state === "unsettled") return { reason, told: seen }

    if (found.seen.every((one) => before.seen.includes(one)))
      return { reason, told: seen, standing: "told" }

    return before.updates >= GIVES_UP_AFTER
      ? { reason, told: before, standing: "gave-up" }
      : {
          reason,
          told: { seen: found.seen, updates: before.updates + 1 },
          due: { reason, detail: found.detail },
          standing: "due",
        }
  })

  return {
    told: withoutUntold({
      ...told,
      ...Object.fromEntries(decided.map((reason) => [reason.reason, reason.told])),
    }),
    due: decided.flatMap(({ due }) => (due === undefined ? [] : [due])),
    standing: Object.fromEntries(
      decided.flatMap(({ reason, standing }) =>
        standing === undefined ? [] : [[reason, standing]],
      ),
    ),
  }
}

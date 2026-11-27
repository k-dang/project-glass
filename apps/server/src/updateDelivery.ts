import { finalEventKinds, type LoggedEvent } from "@glass/contracts"
import type { SubjectEvent } from "./EventLog"
import type { Delivered, SubscriptionState } from "./Subscriptions"

export const GIVES_UP_AFTER = 3

export interface Pending {
  readonly state: SubscriptionState
  readonly events: ReadonlyArray<LoggedEvent>
  readonly wakes: boolean
  readonly updatesInARow: number
}

export const pendingFor = (
  state: SubscriptionState,
  events: ReadonlyArray<SubjectEvent>,
  lastMessageTurn: string | null,
): Pending => {
  const mine = events.flatMap(({ subject, logged }) =>
    logged.source === state.source &&
    subject === state.subjectKey &&
    logged.id > state.deliveredThrough
      ? [logged]
      : [],
  )

  return {
    state,
    events: mine,
    wakes: mine.some(({ event }) => state.kinds.includes(event._tag)),
    updatesInARow: state.afterMessage === lastMessageTurn ? state.updatesInARow : 0,
  }
}

export const gaveUp = ({ updatesInARow }: Pending) => updatesInARow >= GIVES_UP_AFTER

export const tells = (pending: Pending) => pending.wakes && !gaveUp(pending)

export const delivered = (pending: Pending, lastMessageTurn: string | null): Delivered | null => {
  const { state, events } = pending
  const last = events.at(-1)

  if (last === undefined || (pending.wakes && gaveUp(pending))) return null

  const told = tells(pending)

  return {
    subscriptionId: state.id,
    deliveredThrough: last.id,
    updatesInARow: told ? pending.updatesInARow + 1 : state.updatesInARow,
    afterMessage: told ? lastMessageTurn : state.afterMessage,
    ends: events.some(({ event }) => finalEventKinds.has(event._tag)),
  }
}

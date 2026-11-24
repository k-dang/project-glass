import { type AgentReviewDone, InboxThread, type InboxItems, type TurnSeen } from "@glass/contracts"
import { type Cause, Option, Schema, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type BackendError, Backend, backendRuntime } from "./backend"
import { queueRefreshAtom } from "./queue"

export const inboxStreamAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchInbox())))
  .pipe(Atom.keepAlive)

export type InboxResult = AsyncResult.AsyncResult<
  InboxItems,
  BackendError | Cause.NoSuchElementError
>

export const watchedInboxAtom = Atom.make((get): InboxResult => {
  get(queueRefreshAtom)

  return get(inboxStreamAtom)
})

export const threadsInInboxAtom = Atom.make(
  (get): ReadonlyMap<string, InboxThread> =>
    new Map(
      Option.getOrElse(AsyncResult.value(get(watchedInboxAtom)), (): InboxItems => [])
        .filter(Schema.is(InboxThread))
        .map((item) => [item.thread.id, item]),
    ),
)

export const inboxCountAtom = Atom.make((get): Option.Option<number> => {
  const result = get(watchedInboxAtom)

  return AsyncResult.isSuccess(result) ? Option.some(result.value.length) : Option.none()
})

export const markDoneAtom = backendRuntime.fn((review: AgentReviewDone) =>
  Backend.use((backend) => backend.MarkAgentReviewDone(review)),
)

export const markTurnSeenAtom = backendRuntime.fn((seen: TurnSeen) =>
  Backend.use((backend) => backend.MarkTurnSeen(seen)),
)

import { type NeedsYouItem, referenceKey } from "@glass/contracts"
import { type Cause, Match, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type BackendError, Backend, backendRuntime } from "./backend"
import { queueRefreshAtom } from "./queue"

export const needsYouStreamAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchNeedsYou())))
  .pipe(Atom.keepAlive)

export type NeedsYouResult = AsyncResult.AsyncResult<
  ReadonlyArray<NeedsYouItem>,
  BackendError | Cause.NoSuchElementError
>

export const watchedNeedsYouAtom = Atom.make((get): NeedsYouResult => {
  get(queueRefreshAtom)

  return get(needsYouStreamAtom)
})

export const needsYouCount = (result: NeedsYouResult): Option.Option<number> =>
  AsyncResult.isSuccess(result) ? Option.some(result.value.length) : Option.none()

export const needsYouKey = (item: NeedsYouItem): string =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `agent:${agent.id}`,
    OutsideQuestion: ({ id }) => `ask:${id}`,
    PullRequest: ({ pullRequest }) => `pr:${referenceKey(pullRequest.ref)}`,
  })

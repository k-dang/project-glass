import { type NeedsYouItem, referenceKey } from "@glass/contracts"
import { Cause, Data, Match, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type BackendError, Backend, backendRuntime } from "./backend"
import { watchedListingsAtom } from "./pullRequestLists"
import { queueRefreshAtom } from "./queue"

export const needsYouStreamAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchNeedsYou())))
  .pipe(Atom.keepAlive)

export const watchedNeedsYouAtom = Atom.make((get) => {
  get(watchedListingsAtom)
  get(queueRefreshAtom)

  return get(needsYouStreamAtom)
})

type NeedsYouFailure = BackendError | Cause.NoSuchElementError

export type NeedsYouStatus = Data.TaggedEnum<{
  Loading: {}
  Failed: { readonly cause: Cause.Cause<NeedsYouFailure> }
  Ready: { readonly items: ReadonlyArray<NeedsYouItem> }
}>

export const NeedsYouStatus = Data.taggedEnum<NeedsYouStatus>()

export const needsYouStatus = (
  result: AsyncResult.AsyncResult<ReadonlyArray<NeedsYouItem>, NeedsYouFailure>,
): NeedsYouStatus => {
  if (AsyncResult.isSuccess(result)) return NeedsYouStatus.Ready({ items: result.value })

  if (AsyncResult.isFailure(result)) return NeedsYouStatus.Failed({ cause: result.cause })

  return NeedsYouStatus.Loading()
}

export const needsYouCount = (status: NeedsYouStatus): Option.Option<number> =>
  NeedsYouStatus.$match(status, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Ready: ({ items }) => Option.some(items.length),
  })

export const needsYouKey = (item: NeedsYouItem): string =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `agent:${agent.id}`,
    PullRequest: ({ pullRequest }) => `pr:${referenceKey(pullRequest.ref)}`,
  })

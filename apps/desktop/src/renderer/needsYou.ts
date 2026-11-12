import { type NeedsYouItem, referenceKey } from "@glass/contracts"
import { Cause, Data, Match, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { type BackendError, Backend, backendRuntime } from "./backend"
import { watchedListingsAtom } from "./pullRequestLists"
import { queueRefreshAtom } from "./queue"

export const needsYouStreamAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchNeedsYou())))
  .pipe(Atom.keepAlive)

type NeedsYouFailure = BackendError | Cause.NoSuchElementError

export type NeedsYouStatus = Data.TaggedEnum<{
  Loading: {}
  Failed: { readonly cause: Cause.Cause<NeedsYouFailure> }
  Ready: { readonly items: ReadonlyArray<NeedsYouItem> }
}>

export const NeedsYouStatus = Data.taggedEnum<NeedsYouStatus>()

const listingsSettled = (listings: AsyncResult.AsyncResult<unknown, BackendError>) =>
  AsyncResult.isSuccess(listings) ||
  (AsyncResult.isFailure(listings) && Option.isSome(listings.previousSuccess))

export const needsYouStatus = (
  needsYou: AsyncResult.AsyncResult<ReadonlyArray<NeedsYouItem>, NeedsYouFailure>,
  listings: AsyncResult.AsyncResult<unknown, BackendError>,
): NeedsYouStatus => {
  if (AsyncResult.isFailure(needsYou)) return NeedsYouStatus.Failed({ cause: needsYou.cause })

  if (AsyncResult.isFailure(listings) && Option.isNone(listings.previousSuccess)) {
    return NeedsYouStatus.Failed({ cause: listings.cause })
  }

  if (AsyncResult.isSuccess(needsYou) && listingsSettled(listings)) {
    return NeedsYouStatus.Ready({ items: needsYou.value })
  }

  return NeedsYouStatus.Loading()
}

export const watchedNeedsYouAtom = Atom.make((get): NeedsYouStatus => {
  get(queueRefreshAtom)

  return needsYouStatus(get(needsYouStreamAtom), get(watchedListingsAtom))
})

export const needsYouCount = (status: NeedsYouStatus): Option.Option<number> =>
  NeedsYouStatus.$match(status, {
    Loading: () => Option.none(),
    Failed: () => Option.none(),
    Ready: ({ items }) => Option.some(items.length),
  })

export const needsYouKey = (item: NeedsYouItem): string =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `agent:${agent.id}`,
    OutsideQuestion: ({ id }) => `ask:${id}`,
    PullRequest: ({ pullRequest }) => `pr:${referenceKey(pullRequest.ref)}`,
  })

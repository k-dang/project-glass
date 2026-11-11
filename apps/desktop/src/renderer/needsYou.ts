import { type NeedsYouItem, referenceKey } from "@glass/contracts"
import { Match, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Backend, backendRuntime } from "./backend"
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

export const needsYouCountAtom: Atom.Atom<number> = Atom.map(watchedNeedsYouAtom, (result) =>
  Option.getOrElse(
    Option.map(AsyncResult.value(result), (items) => items.length),
    () => 0,
  ),
)

export const needsYouKey = (item: NeedsYouItem): string =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `agent:${agent.id}`,
    PullRequest: ({ pullRequest }) => `pr:${referenceKey(pullRequest.ref)}`,
  })

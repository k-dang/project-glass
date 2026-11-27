import type { InboxItems } from "@glass/contracts"
import { Effect, Option, Predicate, Stream } from "effect"

export const inboxWhen = <E>(
  client: { readonly WatchInbox: () => Stream.Stream<InboxItems, E> },
  until: (items: InboxItems) => boolean,
) => client.WatchInbox().pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

export const pullRequestItem = (items: InboxItems, pullRequest: { readonly url: string }) =>
  items.flatMap((item) =>
    Predicate.isTagged(item, "PullRequest") && item.pullRequest.url === pullRequest.url
      ? [item]
      : [],
  )[0]

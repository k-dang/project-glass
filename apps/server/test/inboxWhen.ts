import type { InboxItems } from "@glass/contracts"
import { Effect, Option, Stream } from "effect"

export const inboxWhen = <E>(
  client: { readonly WatchInbox: () => Stream.Stream<InboxItems, E> },
  until: (items: InboxItems) => boolean,
) => client.WatchInbox().pipe(Stream.filter(until), Stream.runHead, Effect.map(Option.getOrThrow))

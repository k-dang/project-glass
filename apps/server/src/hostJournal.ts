import type { ConversationError } from "@glass/contracts"
import { Data, Effect, Stream } from "effect"
import { HOST_PROTOCOL, type HostEvent } from "./agentHost/protocol"
import type { HostClient } from "./Placement"

export class IncompatibleHost extends Data.TaggedError("IncompatibleHost")<{
  readonly protocol: number | null
}> {}

export interface JournalPosition {
  readonly host: string
  saved: number
}

export const greet = (client: HostClient) =>
  client.Hello().pipe(
    Effect.catchDefect((defect) =>
      String(defect).includes("Unknown request tag: Hello")
        ? Effect.fail(new IncompatibleHost({ protocol: null }))
        : Effect.die(defect),
    ),
    Effect.flatMap(({ host, protocol }) =>
      protocol === HOST_PROTOCOL
        ? Effect.succeed(host)
        : Effect.fail(new IncompatibleHost({ protocol })),
    ),
  )

const acknowledge = (client: HostClient, { host }: JournalPosition, through: number) =>
  // Waiting for the answer would deadlock a fast stream: the answer queues on the same connection
  // behind journal entries the follower hasn't taken yet.
  client.Acknowledge({ host, through }).pipe(Effect.ignore, Effect.forkScoped)

export interface SavedThrough {
  readonly host: string
  readonly through: number
}

export const followJournal = (
  save: (
    conversationId: string,
    events: ReadonlyArray<HostEvent>,
    journal: SavedThrough,
  ) => Effect.Effect<void, ConversationError>,
  client: HostClient,
  position: JournalPosition,
  alreadySaved: (conversationId: string) => number,
) =>
  Effect.gen(function* () {
    yield* acknowledge(client, position, position.saved)
    yield* Stream.suspend(() =>
      client.WatchJournal({ host: position.host, after: position.saved }),
    ).pipe(
      Stream.runForEachArray((entries) =>
        Effect.gen(function* () {
          const unsaved = entries.filter(
            ({ conversationId, sequence }) => sequence > alreadySaved(conversationId),
          )

          for (const [conversationId, saved] of Map.groupBy(
            unsaved,
            (entry) => entry.conversationId,
          ))
            yield* save(
              conversationId,
              saved.map(({ event }) => event),
              { host: position.host, through: saved.at(-1)!.sequence },
            )

          const last = entries.at(-1)

          if (last === undefined) return

          position.saved = last.sequence
          yield* acknowledge(client, position, last.sequence)
        }),
      ),
    )
  })

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

export const followJournal = (
  save: (
    conversationId: string,
    events: ReadonlyArray<HostEvent>,
    throughJournalEntry: number,
  ) => Effect.Effect<void, ConversationError>,
  client: HostClient,
  position: JournalPosition,
) =>
  Effect.gen(function* () {
    yield* acknowledge(client, position, position.saved)
    yield* Stream.suspend(() =>
      client.WatchJournal({ host: position.host, after: position.saved }),
    ).pipe(
      Stream.runForEachArray((entries) =>
        Effect.gen(function* () {
          for (const [conversationId, saved] of Map.groupBy(
            entries,
            (entry) => entry.conversationId,
          ))
            yield* save(
              conversationId,
              saved.map(({ event }) => event),
              saved.at(-1)!.sequence,
            )

          const last = entries.at(-1)

          if (last === undefined) return

          position.saved = last.sequence
          yield* acknowledge(client, position, last.sequence)
        }),
      ),
    )
  })

import type { ConversationError } from "@glass/contracts"
import { Effect, Stream } from "effect"
import type { HostEvent } from "./agentHost/protocol"
import type { HostClient } from "./Placement"

export interface JournalPosition {
  saved: number
}

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
    yield* Stream.suspend(() => client.WatchJournal({ after: position.saved })).pipe(
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

          // Waiting here for the answer would deadlock a fast stream: the answer queues on the
          // same connection behind journal entries this loop hasn't taken yet.
          yield* client
            .Acknowledge({ through: last.sequence })
            .pipe(Effect.ignore, Effect.forkScoped)
        }),
      ),
    )
  })

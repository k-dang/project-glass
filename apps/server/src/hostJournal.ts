import { Effect, Stream } from "effect"
import type { HostClient } from "./Placement"
import type { Transcripts } from "./Transcripts"

export interface JournalPosition {
  saved: number
}

export const followJournal = (
  transcripts: Transcripts["Service"],
  client: HostClient,
  position: JournalPosition,
) =>
  Effect.gen(function* () {
    yield* Stream.suspend(() => client.WatchJournal({ after: position.saved })).pipe(
      Stream.runForEachArray((entries) =>
        Effect.gen(function* () {
          for (const [agentId, saved] of Map.groupBy(entries, (entry) => entry.agentId))
            yield* transcripts.save(
              agentId,
              saved.map(({ event }) => event),
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

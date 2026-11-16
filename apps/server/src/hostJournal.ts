import type { AgentError } from "@glass/contracts"
import { Data, Effect, Stream } from "effect"
import { HOST_PROTOCOL, type HostEvent } from "./agentHost/protocol"
import type { HostClient } from "./Placement"

export class IncompatibleHost extends Data.TaggedError("IncompatibleHost")<{
  readonly protocol: number | null
}> {}

export interface JournalPosition {
  host: string
  saved: number
}

export const greet = (client: HostClient) =>
  client.Hello().pipe(
    // A host from before Hello existed answers it with a defect for an unknown request.
    Effect.catchDefect(() => Effect.fail(new IncompatibleHost({ protocol: null }))),
    Effect.flatMap(({ host, protocol }) =>
      protocol === HOST_PROTOCOL
        ? Effect.succeed(host)
        : Effect.fail(new IncompatibleHost({ protocol })),
    ),
  )

export const followJournal = (
  save: (
    agentId: string,
    events: ReadonlyArray<HostEvent>,
    throughJournalEntry: number,
  ) => Effect.Effect<void, AgentError>,
  client: HostClient,
  position: JournalPosition,
) =>
  Effect.gen(function* () {
    yield* Stream.suspend(() =>
      client.WatchJournal({ host: position.host, after: position.saved }),
    ).pipe(
      Stream.runForEachArray((entries) =>
        Effect.gen(function* () {
          for (const [agentId, saved] of Map.groupBy(entries, (entry) => entry.agentId))
            yield* save(
              agentId,
              saved.map(({ event }) => event),
              saved.at(-1)!.sequence,
            )

          const last = entries.at(-1)

          if (last === undefined) return

          position.saved = last.sequence

          // Waiting here for the answer would deadlock a fast stream: the answer queues on the
          // same connection behind journal entries this loop hasn't taken yet.
          yield* client
            .Acknowledge({ host: position.host, through: last.sequence })
            .pipe(Effect.ignore, Effect.forkScoped)
        }),
      ),
    )
  })

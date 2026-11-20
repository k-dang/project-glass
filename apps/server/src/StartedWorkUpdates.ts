import { StartedWorkUpdate } from "@glass/contracts"
import { Array as Arr, Effect, Layer, Stream } from "effect"
import { Conversations } from "./Conversations"
import { GlobalConversation } from "./GlobalConversation"
import { StartedWork } from "./StartedWork"
import { Transcripts } from "./Transcripts"

export const StartedWorkUpdates = Layer.effectDiscard(
  Effect.gen(function* () {
    const global = yield* GlobalConversation
    const conversations = yield* Conversations
    const started = yield* StartedWork
    const transcripts = yield* Transcripts

    const sendUpdateOnce = (
      startedBy: string,
      whenIdle: (typeof GlobalConversation.Service)["whenIdle"],
    ) =>
      whenIdle((start) =>
        Effect.gen(function* () {
          const found = yield* started.pendingOutcomes(startedBy)

          if (!Arr.isReadonlyArrayNonEmpty(found)) return

          yield* start(
            {
              message: "",
              images: [],
              context: StartedWorkUpdate.make({ work: Arr.map(found, ({ work }) => work) }),
              retriesDelivery: startedBy === global.id,
            },
            (turnId) => started.recordStartedWorkUpdate(startedBy, turnId, found),
          )
        }),
      ).pipe(Effect.andThen(started.reconcileStartedWorkUpdates(startedBy)))

    const sendUpdates = started.starters.pipe(
      Effect.flatMap((starters) =>
        Effect.forEach(
          starters,
          (startedBy) =>
            sendUpdateOnce(
              startedBy,
              startedBy === global.id
                ? global.whenIdle
                : (effect) => conversations.whenIdle(startedBy, effect),
            ).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't send a Started work update", cause),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((cause) => Effect.logWarning("Couldn't read what conversations started", cause)),
    )

    yield* Stream.merge(started.changes, yield* transcripts.subscribeSettled).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => sendUpdates),
      Effect.forkScoped,
    )
  }),
)

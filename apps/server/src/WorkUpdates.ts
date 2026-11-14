import { WorkUpdate } from "@glass/contracts"
import { Array as Arr, Effect, Layer, Predicate, Stream } from "effect"
import { GlobalConversation } from "./GlobalConversation"
import { StartedWork } from "./StartedWork"

export const WorkUpdates = Layer.effectDiscard(
  Effect.gen(function* () {
    const conversation = yield* GlobalConversation
    const started = yield* StartedWork

    const sendUpdateOnce = conversation
      .whenIdle((workUpdate) =>
        Effect.gen(function* () {
          const found = yield* started.pendingOutcomes(conversation.id)

          if (!Arr.isReadonlyArrayNonEmpty(found)) return

          yield* workUpdate(
            WorkUpdate.make({ work: Arr.map(found, ({ work }) => work) }),
            (turnId) => started.recordWorkUpdate(conversation.id, turnId, found),
          )
        }),
      )
      .pipe(
        Effect.andThen(started.reconcileWorkUpdates(conversation.id)),
        Effect.catch((cause) => Effect.logWarning("Couldn't send a Work update", cause)),
      )

    const settled = conversation.transcript.pipe(
      Stream.filter(
        (update) =>
          Predicate.isTagged(update, "TurnEnded") ||
          Predicate.isTagged(update, "QueuedMessagesChanged"),
      ),
      Stream.catch(() => Stream.empty),
    )

    yield* Stream.merge(started.changes(conversation.id), settled).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => sendUpdateOnce),
      Effect.forkScoped,
    )
  }),
)

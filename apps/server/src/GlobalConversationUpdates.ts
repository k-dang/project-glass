import { GlobalConversationUpdate } from "@glass/contracts"
import { Array as Arr, Effect, Layer, Predicate, Stream } from "effect"
import { GlobalConversation } from "./GlobalConversation"
import { StartedWork } from "./StartedWork"

export const GlobalConversationUpdates = Layer.effectDiscard(
  Effect.gen(function* () {
    const conversation = yield* GlobalConversation
    const started = yield* StartedWork

    const sendUpdateOnce = conversation
      .whenIdle((globalConversationUpdate) =>
        Effect.gen(function* () {
          const found = yield* started.pendingOutcomes(conversation.id)

          if (!Arr.isReadonlyArrayNonEmpty(found)) return

          yield* globalConversationUpdate(
            GlobalConversationUpdate.make({ work: Arr.map(found, ({ work }) => work) }),
            (turnId) => started.recordGlobalConversationUpdate(conversation.id, turnId, found),
          )
        }),
      )
      .pipe(
        Effect.andThen(started.reconcileGlobalConversationUpdates(conversation.id)),
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't send a Global conversation update", cause),
        ),
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

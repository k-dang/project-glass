import { WorkReport } from "@glass/contracts"
import { Array as Arr, Effect, Layer, Predicate, Stream } from "effect"
import { GlobalConversation } from "./GlobalConversation"
import { StartedWork } from "./StartedWork"

export const WorkReports = Layer.effectDiscard(
  Effect.gen(function* () {
    const conversation = yield* GlobalConversation
    const started = yield* StartedWork

    const reportOnce = conversation
      .whenIdle((report) =>
        Effect.gen(function* () {
          const found = yield* started.unreported(conversation.id)

          if (!Arr.isReadonlyArrayNonEmpty(found)) return

          yield* report(WorkReport.make({ work: Arr.map(found, ({ work }) => work) }))
          yield* started.markReported(conversation.id, found)
        }),
      )
      .pipe(Effect.catch((cause) => Effect.logWarning("Couldn't report started work", cause)))

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
      Stream.runForEach(() => reportOnce),
      Effect.forkScoped,
    )
  }),
)

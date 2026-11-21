import { Effect, Layer, Predicate, Schema, Stream } from "effect"
import { ConversationPullRequests } from "./ConversationPullRequests"
import { LinkedCompletion, ToDos } from "./ToDos"

const sameMerged = Schema.toEquivalence(Schema.Array(LinkedCompletion))

export const CompleteToDosOnMerge = Layer.effectDiscard(
  Effect.gen(function* () {
    const pullRequests = yield* ConversationPullRequests
    const toDos = yield* ToDos

    yield* pullRequests.watch().pipe(
      Stream.map((listed) =>
        listed.flatMap(({ conversationId, state }) =>
          Predicate.isTagged(state, "Merged")
            ? [{ conversationId, completedAt: state.mergedAt }]
            : [],
        ),
      ),
      Stream.filter((merged) => merged.length > 0),
      Stream.changesWith(sameMerged),
      Stream.runForEach((merged) =>
        toDos.completeLinked(merged).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Couldn't mark a merged Conversation's To-dos done", error),
          ),
          Effect.withSpan("CompleteToDosOnMerge", { root: true }),
        ),
      ),
      Effect.forkScoped,
    )
  }),
)

import type { ConversationPullRequest } from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Predicate, Schema, Stream } from "effect"
import { ConversationPullRequests } from "./ConversationPullRequests"
import { Conversations } from "./Conversations"
import { Transcripts, type WaitingByConversation } from "./Transcripts"

const sameIds = Schema.toEquivalence(Schema.Array(Schema.String))

const isSettled = (
  { conversationId, state }: ConversationPullRequest,
  running: ReadonlySet<string>,
  waiting: WaitingByConversation,
  keptGoing: ReadonlyMap<string, DateTime.Utc>,
) => {
  if (!Predicate.isTagged(state, "Merged")) return false

  if (running.has(conversationId) || waiting.has(conversationId)) return false

  const lastKeptGoing = keptGoing.get(conversationId)

  return lastKeptGoing === undefined || DateTime.isGreaterThan(state.mergedAt, lastKeptGoing)
}

export class SettledConversations extends Context.Service<
  SettledConversations,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<string>>
  }
>()("@glass/server/SettledConversations") {
  static readonly layer = Layer.effect(
    SettledConversations,
    Effect.gen(function* () {
      const pullRequests = yield* ConversationPullRequests
      const conversations = yield* Conversations
      const transcripts = yield* Transcripts

      return SettledConversations.of({
        watch: () =>
          Stream.zipLatestAll(
            pullRequests.watch(),
            transcripts.running,
            transcripts.waiting,
            conversations.keptGoing,
          ).pipe(
            Stream.map(([listed, running, waiting, keptGoing]) =>
              listed
                .filter((pullRequest) => isSettled(pullRequest, running, waiting, keptGoing))
                .map(({ conversationId }) => conversationId),
            ),
            Stream.changesWith(sameIds),
          ),
      })
    }),
  )
}

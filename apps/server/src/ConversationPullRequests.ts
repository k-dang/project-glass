import {
  type Conversation,
  type ConversationError,
  ConversationPullRequest,
} from "@glass/contracts"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { Conversations } from "./Conversations"
import { PullRequestLists } from "./PullRequestLists"
import { type Mirror, mirrorOf, PullRequestMirror, summaryOf } from "./PullRequestMirror"
import { Transcripts } from "./Transcripts"

const sameList = Schema.toEquivalence(Schema.Array(ConversationPullRequest))

const pullRequestsOf = (
  conversations: ReadonlyArray<Conversation>,
  mirror: Mirror | undefined,
): ReadonlyArray<ConversationPullRequest> =>
  mirror === undefined
    ? []
    : conversations.flatMap(({ id, repository, branch }) => {
        if (branch === null) return []

        const pullRequest = mirrorOf(mirror, repository)?.pullRequests.find(
          (pr) => pr.headBranch === branch,
        )

        return pullRequest === undefined
          ? []
          : [
              new ConversationPullRequest({
                conversationId: id,
                pullRequest: summaryOf(pullRequest),
              }),
            ]
      })

export class ConversationPullRequests extends Context.Service<
  ConversationPullRequests,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<ConversationPullRequest>, ConversationError>
  }
>()("@glass/server/ConversationPullRequests") {
  static readonly layer = Layer.effect(
    ConversationPullRequests,
    Effect.gen(function* () {
      const conversations = yield* Conversations
      const mirror = yield* PullRequestMirror
      const lists = yield* PullRequestLists
      const transcripts = yield* Transcripts

      // A Turn is when an agent opens or pushes to a PR, so see it now rather than minutes later.
      const afterTurn = (conversationId: string) =>
        conversations.followBranch(conversationId).pipe(
          Effect.flatMap((followed) => (followed ? lists.refreshSoon : Effect.void)),
          // Defects too, such as from a Sandbox host older than CurrentBranch, so one Conversation
          // can't stop the rest from following their branches.
          Effect.catchCause((cause) =>
            Effect.logWarning("Couldn't read a Conversation's branch", cause),
          ),
          Effect.withSpan("ConversationPullRequests.afterTurn", { root: true }),
        )

      yield* (yield* transcripts.subscribeEnded).pipe(
        Stream.mapEffect(afterTurn, { concurrency: "unbounded" }),
        Stream.runDrain,
        Effect.forkScoped,
      )

      return ConversationPullRequests.of({
        watch: () =>
          Stream.zipLatest(conversations.watch(), mirror.changes).pipe(
            Stream.map(([current, mirrored]) => pullRequestsOf(current, mirrored)),
            Stream.changesWith(sameList),
          ),
      })
    }),
  )
}

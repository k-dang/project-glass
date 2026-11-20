import {
  type Conversation,
  ConversationPullRequest,
  PullRequestOpen,
  repositoryKey,
} from "@glass/contracts"
import { Context, Effect, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect"
import type { Branch, EndedPullRequest } from "./github/branchPullRequests"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { Conversations } from "./Conversations"
import { PullRequestLists } from "./PullRequestLists"
import { type Mirror, mirrorOf, PullRequestMirror } from "./PullRequestMirror"
import { Transcripts } from "./Transcripts"
import { annotateUnit } from "./wideEvents"

const sameList = Schema.toEquivalence(Schema.Array(ConversationPullRequest))

type Ended = ReadonlyMap<string, EndedPullRequest>

const branchKey = ({ repository, branch }: Branch) => `${repositoryKey(repository)}#${branch}`

const branchOf = ({ repository, branch }: Conversation): Branch | undefined =>
  branch === null ? undefined : { repository, branch }

const openPullRequestOf = (mirror: Mirror, { repository, branch }: Branch) =>
  mirrorOf(mirror, repository)?.pullRequests.find((pr) => pr.headBranch === branch)

const endedLookups = (
  conversations: ReadonlyArray<Conversation>,
  mirror: Mirror | undefined,
): ReadonlyArray<Branch> => {
  if (mirror === undefined) return []

  const lookups = new Map<string, Branch>()

  for (const conversation of conversations) {
    const branch = branchOf(conversation)

    if (
      branch !== undefined &&
      branch.branch !== conversation.baseBranch &&
      mirrorOf(mirror, branch.repository) !== undefined &&
      openPullRequestOf(mirror, branch) === undefined
    ) {
      lookups.set(branchKey(branch), branch)
    }
  }

  return [...lookups.values()]
}

const pullRequestsOf = (
  conversations: ReadonlyArray<Conversation>,
  mirror: Mirror | undefined,
  ended: Ended,
): ReadonlyArray<ConversationPullRequest> =>
  mirror === undefined
    ? []
    : conversations.flatMap((conversation) => {
        const branch = branchOf(conversation)

        if (branch === undefined) return []

        const open = openPullRequestOf(mirror, branch)

        const found =
          open === undefined
            ? ended.get(branchKey(branch))
            : { ...open, state: PullRequestOpen.make({ checks: open.checks }) }

        return found === undefined
          ? []
          : [
              new ConversationPullRequest({
                conversationId: conversation.id,
                ref: found.ref,
                url: found.url,
                title: found.title,
                state: found.state,
              }),
            ]
      })

export class ConversationPullRequests extends Context.Service<
  ConversationPullRequests,
  {
    readonly watch: () => Stream.Stream<ReadonlyArray<ConversationPullRequest>>
  }
>()("@glass/server/ConversationPullRequests") {
  static readonly layer = Layer.effect(
    ConversationPullRequests,
    Effect.gen(function* () {
      const conversations = yield* Conversations
      const mirror = yield* PullRequestMirror
      const lists = yield* PullRequestLists
      const transcripts = yield* Transcripts
      const github = yield* GitHubClient
      const listed = yield* SubscriptionRef.make<ReadonlyArray<ConversationPullRequest>>([])
      const ended = yield* Ref.make<Ended>(new Map())

      const asked = yield* Ref.make<{ readonly mirrored: Mirror; readonly keys: string } | null>(
        null,
      )

      const afterTurn = (conversationId: string) =>
        conversations.followBranch(conversationId).pipe(
          Effect.flatMap((followed) => (followed ? lists.refreshSoon : Effect.void)),
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

      const lookUpEnded = Effect.fnUntraced(function* (branches: ReadonlyArray<Branch>) {
        const known = yield* Ref.get(ended)
        const unknown = branches.filter((branch) => !known.has(branchKey(branch)))
        yield* annotateUnit({ ended_lookups: unknown.length })
        const answers = yield* github.endedBranchPullRequests(unknown)
        const found = new Map(unknown.map((branch, index) => [branchKey(branch), answers[index]]))

        yield* Ref.set(
          ended,
          new Map(
            branches.flatMap((branch) => {
              const key = branchKey(branch)
              const pullRequest = known.get(key) ?? found.get(key)

              return pullRequest == null ? [] : [[key, pullRequest] as const]
            }),
          ),
        )
      })

      const publish = Effect.fnUntraced(function* (
        current: ReadonlyArray<Conversation>,
        mirrored: Mirror | undefined,
      ) {
        const branches = endedLookups(current, mirrored)
        const keys = branches.map(branchKey).join()
        const last = yield* Ref.get(asked)

        if (mirrored !== undefined && (last?.mirrored !== mirrored || last.keys !== keys)) {
          yield* lookUpEnded(branches).pipe(
            Effect.andThen(Ref.set(asked, { mirrored, keys })),
            Effect.provideService(BackgroundGitHubRequest, true),
            Effect.catch((error) =>
              Effect.logWarning("Couldn't read the Conversations' merged and closed PRs", error),
            ),
            Effect.withSpan("ConversationPullRequests.lookUpEnded", { root: true }),
          )
        }

        yield* SubscriptionRef.set(listed, pullRequestsOf(current, mirrored, yield* Ref.get(ended)))
      })

      yield* Stream.zipLatest(conversations.watch(), mirror.changes).pipe(
        Stream.switchMap(([current, mirrored]) => Stream.fromEffect(publish(current, mirrored))),
        Stream.runDrain,
        Effect.catchCause((cause) =>
          Effect.logWarning("Stopped following the Conversations' PRs", cause),
        ),
        Effect.forkScoped,
      )

      return ConversationPullRequests.of({
        watch: () => SubscriptionRef.changes(listed).pipe(Stream.changesWith(sameList)),
      })
    }),
  )
}

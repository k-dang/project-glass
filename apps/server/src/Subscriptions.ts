import {
  type ConnectionError,
  type FollowedRepository,
  PullRequestRef,
  referenceKey,
  repositoryKey,
  type SettingsError,
  Subscription,
  SubscriptionReason,
  ThreadError,
  type ThreadPullRequest,
  type TurnContext,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import { FollowedRepositories } from "./FollowedRepositories"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { type Mirror, PullRequestMirror } from "./PullRequestMirror"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Transcripts } from "./Transcripts"

export interface NewSubscription {
  readonly pullRequest: PullRequestRef | null
  readonly reasons: ReadonlyArray<SubscriptionReason>
  readonly note: string
}

const ReasonsJson = Schema.fromJsonString(Schema.Array(SubscriptionReason))

const encodeReasons = Schema.encodeSync(ReasonsJson)

const StoredSubscription = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  source: Subscription.fields.source,
  owner: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  number: Schema.NullOr(Schema.Int),
  reasons: ReasonsJson,
  note: Schema.String,
})

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredSubscription))

const decodeNamed = Schema.decodeUnknownEffect(Schema.Array(PullRequestRef))

const subscriptionOf = ({ owner, repo, number, ...stored }: typeof StoredSubscription.Type) =>
  new Subscription({
    ...stored,
    pullRequest:
      owner === null || repo === null || number === null ? null : { owner, repo, number },
  })

const pullRequestKey = (pullRequest: PullRequestRef | null) =>
  pullRequest === null ? null : referenceKey(pullRequest)

const named = ({ owner, repo, number }: PullRequestRef) => `${owner}/${repo}#${number}`

const startedByGlass = (context: TurnContext | null) =>
  Predicate.isTagged(context, "StartedWorkUpdate")

const refuse = (message: string) => Effect.fail(new ThreadError({ message }))

const refuseEnded = (pullRequest: string, state: "merged" | "closed") =>
  refuse(`${pullRequest} has already ${state}, so there's nothing left to tell your Thread about.`)

const hasEnded = ({ state }: ThreadPullRequest) => !Predicate.isTagged(state, "Open")

// WARNING: GitHub matches owner and repository names ignoring case, and a Followed repository keeps the case the user typed.
const isRepositoryOf =
  ({ owner, repo }: PullRequestRef) =>
  (repository: FollowedRepository) =>
    repositoryKey(repository).toLowerCase() === `${owner}/${repo}`.toLowerCase()

const isOpenIn = (mirror: Mirror, pullRequest: PullRequestRef) =>
  mirror.repositories
    .find(({ repository }) => isRepositoryOf(pullRequest)(repository))
    ?.pullRequests.some(({ ref }) => ref.number === pullRequest.number)

const sameSubscriptions = Schema.toEquivalence(Schema.Array(Subscription))

const storageFailure = (cause: SqlError.SqlError | Schema.SchemaError) =>
  Effect.logWarning("Couldn't read or save a Subscription", cause).pipe(
    Effect.andThen(
      Effect.fail(new ThreadError({ message: "Couldn't read or save the Subscription." })),
    ),
  )

export class Subscriptions extends Context.Service<
  Subscriptions,
  {
    readonly subscribe: (
      threadId: string,
      input: NewSubscription,
    ) => Effect.Effect<Subscription, ThreadError | SettingsError | ConnectionError>
    readonly list: (threadId: string) => Effect.Effect<ReadonlyArray<Subscription>, ThreadError>
    readonly watch: (threadId: string) => Stream.Stream<ReadonlyArray<Subscription>, ThreadError>
    readonly end: (threadId: string, subscriptionId: string) => Effect.Effect<boolean, ThreadError>
  }
>()("@glass/server/Subscriptions") {
  static readonly layer = Layer.effect(
    Subscriptions,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const followed = yield* FollowedRepositories
      const github = yield* GitHubClient
      const transcripts = yield* Transcripts
      const threadPullRequests = yield* ThreadPullRequests
      const mirror = yield* PullRequestMirror
      const writes = yield* SubscriptionRef.make(0)

      const wrote = SubscriptionRef.update(writes, (count) => count + 1)

      const list = (threadId: string) =>
        sql`
          SELECT id, thread_id AS threadId, source, owner, repo, number, reasons, note
          FROM subscription WHERE thread_id = ${threadId} ORDER BY created_at, id
        `.pipe(
          Effect.flatMap(decodeStored),
          Effect.map((stored) => stored.map(subscriptionOf)),
          Effect.catch(storageFailure),
        )

      const lookUp = (pullRequests: ReadonlyArray<PullRequestRef>) =>
        github
          .queuedPullRequests(pullRequests)
          .pipe(Effect.provideService(BackgroundGitHubRequest, true))

      const refuseOwnEnded = Effect.fnUntraced(function* (threadId: string) {
        const listed = yield* threadPullRequests.watch().pipe(Stream.runHead)
        const own = Option.getOrThrow(listed).find((candidate) => candidate.threadId === threadId)

        if (own !== undefined && hasEnded(own))
          yield* refuseEnded(
            `Your Thread's PR #${own.ref.number}`,
            Predicate.isTagged(own.state, "Merged") ? "merged" : "closed",
          )
      })

      const followedPullRequest = Effect.fnUntraced(function* (pullRequest: PullRequestRef) {
        if (!(yield* followed.list()).some(isRepositoryOf(pullRequest)))
          return yield* refuse(
            `Glass only knows PRs in the repositories the user follows, and ${pullRequest.owner}/${pullRequest.repo} isn't one. Ask the user to follow it in Glass.`,
          )

        const [found] = yield* lookUp([pullRequest])

        if (found == null)
          return yield* refuse(
            `GitHub has no PR ${named(pullRequest)}, or the user's GitHub login can't see it.`,
          )

        if (found.state === "merged" || found.state === "closed")
          return yield* refuseEnded(`PR ${named(pullRequest)}`, found.state)

        return found.summary.ref
      })

      const subscribe = Effect.fn("Subscriptions.subscribe")(function* (
        threadId: string,
        input: NewSubscription,
      ) {
        if (startedByGlass(yield* transcripts.runningContext(threadId)))
          return yield* refuse(
            "Glass started this Turn, so it can't subscribe your Thread to a PR. Only a Turn the user's message started can.",
          )

        if (input.pullRequest === null) yield* refuseOwnEnded(threadId)

        const pullRequest =
          input.pullRequest === null ? null : yield* followedPullRequest(input.pullRequest)

        const reasons = encodeReasons(input.reasons)
        const now = yield* DateTime.now

        const subscription = yield* Effect.gen(function* () {
          const existing = (yield* list(threadId)).find(
            (candidate) => pullRequestKey(candidate.pullRequest) === pullRequestKey(pullRequest),
          )

          const saved = new Subscription({
            id: existing?.id ?? randomUUID(),
            threadId,
            source: "github",
            pullRequest,
            reasons: input.reasons,
            note: input.note,
          })

          yield* (
            existing === undefined
              ? sql`INSERT INTO subscription ${sql.insert({
                  id: saved.id,
                  thread_id: threadId,
                  source: saved.source,
                  owner: pullRequest?.owner ?? null,
                  repo: pullRequest?.repo ?? null,
                  number: pullRequest?.number ?? null,
                  reasons,
                  note: input.note,
                  created_at: DateTime.formatIso(now),
                })}`
              : sql`
                  UPDATE subscription SET ${sql.update({ reasons, note: input.note })}
                  WHERE id = ${saved.id}
                `
          ).pipe(Effect.catch(storageFailure))

          return saved
        }).pipe(sql.withTransaction, Effect.catchTag("SqlError", storageFailure))

        yield* wrote

        return subscription
      })

      const end = Effect.fn("Subscriptions.end")(function* (
        threadId: string,
        subscriptionId: string,
      ) {
        const ended = yield* sql`
          DELETE FROM subscription WHERE id = ${subscriptionId} AND thread_id = ${threadId}
          RETURNING id
        `.pipe(Effect.catch(storageFailure))

        yield* wrote

        return ended.length > 0
      })

      const endOwn = Effect.fnUntraced(function* (listed: ReadonlyArray<ThreadPullRequest>) {
        const threadIds = listed.flatMap((own) => (hasEnded(own) ? [own.threadId] : []))

        if (threadIds.length === 0) return

        const ended = yield* sql`
          DELETE FROM subscription WHERE owner IS NULL AND ${sql.in("thread_id", threadIds)}
          RETURNING id
        `

        if (ended.length > 0) yield* wrote
      })

      const endNamed = Effect.fnUntraced(function* (mirrored: Mirror | undefined) {
        if (mirrored === undefined) return

        const subscribed = yield* sql`
          SELECT DISTINCT owner, repo, number FROM subscription WHERE owner IS NOT NULL
        `.pipe(Effect.flatMap(decodeNamed))

        const gone = subscribed.filter((pullRequest) => isOpenIn(mirrored, pullRequest) === false)

        if (gone.length === 0) return

        const found = yield* lookUp(gone)

        const ended = gone.filter((_, index) => {
          const state = found[index]?.state

          return state === "merged" || state === "closed"
        })

        yield* Effect.forEach(
          ended,
          ({ owner, repo, number }) =>
            sql`
              DELETE FROM subscription
              WHERE owner = ${owner} AND repo = ${repo} AND number = ${number}
            `,
          { discard: true },
        )

        if (ended.length > 0) yield* wrote
      })

      const endingMergedOrClosed = <A, E>(
        seen: Stream.Stream<A>,
        endSeen: (seen: A) => Effect.Effect<void, E>,
      ) =>
        Stream.zipLatest(seen, SubscriptionRef.changes(writes)).pipe(
          Stream.runForEach(([latest]) =>
            endSeen(latest).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't end the Subscriptions of merged and closed PRs", cause),
              ),
            ),
          ),
          Effect.forkScoped,
        )

      yield* endingMergedOrClosed(threadPullRequests.watch(), endOwn)
      yield* endingMergedOrClosed(mirror.changes, endNamed)

      return Subscriptions.of({
        subscribe,
        list,
        end,
        watch: (threadId) =>
          SubscriptionRef.changes(writes).pipe(
            Stream.mapEffect(() => list(threadId)),
            Stream.changesWith(sameSubscriptions),
          ),
      })
    }),
  )
}

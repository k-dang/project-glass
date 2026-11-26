import {
  type ConnectionError,
  PullRequestRef,
  referenceKey,
  referenceText,
  type SettingsError,
  Subscription,
  SubscriptionReason,
  ThreadError,
  type ThreadPullRequest,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError, type Statement } from "effect/sql"
import { randomUUID } from "node:crypto"
import { EventLog } from "./EventLog"
import { FollowedRepositories } from "./FollowedRepositories"
import { endedEvent } from "./gitHubSource"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import {
  isRepositoryOf,
  type Mirror,
  mirroredPullRequest,
  mirroredRepositoryOf,
  PullRequestMirror,
} from "./PullRequestMirror"
import { countedAfresh, EndedState, nothingTold, Told } from "./pullRequestUpdateDecision"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { isOnTheUsersWord } from "./threadState"
import { Transcripts } from "./Transcripts"

export interface NewSubscription {
  readonly pullRequest: PullRequestRef | null
  readonly reasons: ReadonlyArray<SubscriptionReason>
  readonly note: string
}

const ReasonsJson = Schema.fromJsonString(Schema.Array(SubscriptionReason))

const encodeReasons = Schema.encodeSync(ReasonsJson)

const Ended = Schema.Struct({
  state: EndedState,
  pullRequest: PullRequestRef,
})

type Ended = typeof Ended.Type

const encodeEnded = Schema.encodeSync(Schema.fromJsonString(Ended))

const LastTold = Schema.Struct({
  pullRequest: Schema.String,
  told: Told,
  afterMessage: Schema.NullOr(Schema.String),
})

type LastTold = typeof LastTold.Type

const encodeTold = Schema.encodeSync(Schema.fromJsonString(LastTold))

const StoredSubscription = Schema.Struct({
  id: Schema.String,
  threadId: Schema.String,
  source: Subscription.fields.source,
  owner: Schema.NullOr(Schema.String),
  repo: Schema.NullOr(Schema.String),
  number: Schema.NullOr(Schema.Int),
  reasons: ReasonsJson,
  note: Schema.String,
  lastTold: Schema.NullOr(Schema.fromJsonString(LastTold)),
  ended: Schema.NullOr(Schema.fromJsonString(Ended)),
})

type StoredSubscription = typeof StoredSubscription.Type

const decodeStored = Schema.decodeUnknownEffect(Schema.Array(StoredSubscription))

const decodeThreadIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: Schema.String })),
)

const subscriptionOf = ({
  id,
  threadId,
  source,
  owner,
  repo,
  number,
  reasons,
  note,
}: StoredSubscription) =>
  new Subscription({
    id,
    threadId,
    source,
    reasons,
    note,
    pullRequest:
      owner === null || repo === null || number === null ? null : { owner, repo, number },
  })

export interface SubscriptionState {
  readonly subscription: Subscription
  readonly toldAbout: (pullRequest: PullRequestRef, lastMessageTurn: string | null) => Told
  readonly ended: Ended | null
}

export interface ToldSubscription {
  readonly subscriptionId: string
  readonly pullRequest: PullRequestRef
  readonly told: Told
  readonly ends: boolean
}

const stateOf = (stored: StoredSubscription): SubscriptionState => ({
  subscription: subscriptionOf(stored),
  toldAbout: (pullRequest, lastMessageTurn) => {
    const last = stored.lastTold

    if (last?.pullRequest !== referenceKey(pullRequest)) return nothingTold

    return last.afterMessage === lastMessageTurn ? last.told : countedAfresh(last.told)
  },
  ended: stored.ended,
})

const pullRequestKey = (pullRequest: PullRequestRef | null) =>
  pullRequest === null ? null : referenceKey(pullRequest)

const refusedStarters = {
  glass: "Glass started this Turn",
  harness: "The agent started this Turn by itself",
  agent: "A message from another agent started this Turn",
  none: "Your Thread has no Turn running",
}

const refuse = (message: string) => Effect.fail(new ThreadError({ message }))

const refuseEnded = (pullRequest: string, state: EndedState) =>
  refuse(`${pullRequest} has already ${state}, so there's nothing left to tell your Thread about.`)

const endedStateOf = ({ state }: ThreadPullRequest): EndedState | null => {
  if (Predicate.isTagged(state, "Open")) return null

  return Predicate.isTagged(state, "Merged") ? "merged" : "closed"
}

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
    readonly changes: Stream.Stream<unknown>
    readonly subscribedThreads: Effect.Effect<ReadonlyArray<string>, ThreadError>
    readonly states: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<SubscriptionState>, ThreadError>
    readonly recordTold: (
      told: ReadonlyArray<ToldSubscription>,
      lastMessageTurn: string | null,
    ) => Effect.Effect<void, ThreadError>
    readonly announceChange: Effect.Effect<void>
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
      const events = yield* EventLog
      const writes = yield* SubscriptionRef.make(0)

      const wrote = SubscriptionRef.update(writes, (count) => count + 1)

      const stored = (matching: Statement.Fragment) =>
        sql`
          SELECT id, thread_id AS threadId, source, owner, repo, number, reasons, note,
            last_told AS lastTold, ended
          FROM subscription WHERE ${matching} ORDER BY created_at, id
        `.pipe(Effect.flatMap(decodeStored))

      const storedOf = (threadId: string) =>
        stored(sql`thread_id = ${threadId}`).pipe(Effect.catch(storageFailure))

      const list = (threadId: string) =>
        storedOf(threadId).pipe(Effect.map((found) => found.map(subscriptionOf)))

      const lookUp = (pullRequests: ReadonlyArray<PullRequestRef>) =>
        github
          .queuedPullRequests(pullRequests)
          .pipe(Effect.provideService(BackgroundGitHubRequest, true))

      const refuseOwnEnded = Effect.fnUntraced(function* (threadId: string) {
        const own = yield* threadPullRequests.ofThread(threadId)
        const ended = own === undefined ? null : endedStateOf(own)

        if (own !== undefined && ended !== null)
          yield* refuseEnded(`Your Thread's PR #${own.ref.number}`, ended)
      })

      const followedPullRequest = Effect.fnUntraced(function* (pullRequest: PullRequestRef) {
        if (!(yield* followed.list()).some(isRepositoryOf(pullRequest)))
          return yield* refuse(
            `Glass only knows PRs in the repositories the user follows, and ${pullRequest.owner}/${pullRequest.repo} isn't one. Ask the user to follow it in Glass.`,
          )

        const [found] = yield* lookUp([pullRequest])

        if (found == null)
          return yield* refuse(
            `GitHub has no PR ${referenceText(pullRequest)}, or the user's GitHub login can't see it.`,
          )

        if (found.state === "merged" || found.state === "closed")
          return yield* refuseEnded(`PR ${referenceText(pullRequest)}`, found.state)

        return found.summary.ref
      })

      const subscribe = Effect.fn("Subscriptions.subscribe")(function* (
        threadId: string,
        input: NewSubscription,
      ) {
        const starter = yield* transcripts.runningTurnStarter(threadId)

        if (!isOnTheUsersWord(starter))
          return yield* refuse(
            `${refusedStarters[starter ?? "none"]}, so it can't subscribe your Thread to a PR. Only a Turn started by the user's message, or by a message from the Thread or Global chat that created your Thread, can.`,
          )

        if (input.pullRequest === null) yield* refuseOwnEnded(threadId)

        const pullRequest =
          input.pullRequest === null ? null : yield* followedPullRequest(input.pullRequest)

        const reasons = encodeReasons(input.reasons)
        const now = yield* DateTime.now

        const subscription = yield* Effect.gen(function* () {
          const existing = (yield* storedOf(threadId))
            .filter(({ ended }) => ended === null)
            .map(subscriptionOf)
            .find(
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

      const endTold = Effect.fnUntraced(function* (
        subscriptions: ReadonlyArray<StoredSubscription>,
        ended: Ended,
      ) {
        yield* Effect.forEach(
          subscriptions,
          ({ id, reasons }) =>
            reasons.includes("merged-or-closed")
              ? sql`UPDATE subscription SET ended = ${encodeEnded(ended)} WHERE id = ${id}`
              : sql`DELETE FROM subscription WHERE id = ${id}`,
          { discard: true },
        )

        if (subscriptions.length > 0) yield* wrote
      })

      const endOwn = Effect.fnUntraced(function* (listed: ReadonlyArray<ThreadPullRequest>) {
        const ended = listed.flatMap((own) => {
          const state = endedStateOf(own)

          return state === null ? [] : [{ own, state }]
        })

        if (ended.length === 0) return

        const subscriptions = yield* stored(sql`owner IS NULL AND ended IS NULL`)

        yield* Effect.forEach(
          ended,
          ({ own, state }) =>
            endTold(
              subscriptions.filter(({ threadId }) => threadId === own.threadId),
              { state, pullRequest: own.ref },
            ),
          { discard: true },
        )
      })

      const endNamed = Effect.fnUntraced(function* (mirrored: Mirror | undefined) {
        if (mirrored === undefined) return

        const gone = Object.values(
          Arr.groupBy(
            (yield* stored(sql`owner IS NOT NULL AND ended IS NULL`)).flatMap((subscription) => {
              const { pullRequest } = subscriptionOf(subscription)

              return pullRequest !== null &&
                mirroredRepositoryOf(mirrored, pullRequest) !== undefined &&
                mirroredPullRequest(mirrored, pullRequest) === undefined
                ? [{ subscription, pullRequest }]
                : []
            }),
            ({ pullRequest }) => referenceKey(pullRequest),
          ),
        )

        if (gone.length === 0) return

        const found = yield* lookUp(gone.map(([{ pullRequest }]) => pullRequest))

        yield* Effect.forEach(
          Arr.zip(gone, found),
          ([group, lookedUp]) => {
            if (lookedUp === null || (lookedUp.state !== "merged" && lookedUp.state !== "closed"))
              return Effect.void

            const event = endedEvent(lookedUp)

            return events.record("github", event === null ? [] : [event]).pipe(
              Effect.andThen(
                endTold(
                  group.map(({ subscription }) => subscription),
                  { state: lookedUp.state, pullRequest: group[0].pullRequest },
                ),
              ),
            )
          },
          { discard: true },
        )
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
        changes: SubscriptionRef.changes(writes),
        subscribedThreads: sql`
          SELECT thread_id AS threadId FROM subscription
          GROUP BY thread_id ORDER BY MIN(created_at), MIN(rowid)
        `.pipe(
          Effect.flatMap(decodeThreadIds),
          Effect.map((found) => found.map(({ threadId }) => threadId)),
          Effect.catch(storageFailure),
        ),
        states: (threadId) => storedOf(threadId).pipe(Effect.map((found) => found.map(stateOf))),
        recordTold: (told, lastMessageTurn) =>
          Effect.forEach(
            told,
            ({ subscriptionId, pullRequest, told: state, ends }) =>
              ends
                ? sql`DELETE FROM subscription WHERE id = ${subscriptionId}`
                : sql`
                    UPDATE subscription
                    SET last_told = ${encodeTold({
                      pullRequest: referenceKey(pullRequest),
                      told: state,
                      afterMessage: lastMessageTurn,
                    })}
                    WHERE id = ${subscriptionId}
                  `,
            { discard: true },
          ).pipe(Effect.catch(storageFailure)),
        announceChange: wrote,
      })
    }),
  )
}

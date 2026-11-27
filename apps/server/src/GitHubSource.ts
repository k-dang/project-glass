import {
  type ConnectionError,
  type Event,
  type LoggedEvent,
  PullRequestEnding,
  type PullRequestRef,
  PullRequestSubject,
  PullRequestUpdate,
  type PullRequestUpdateReason,
  referenceKey,
  referenceText,
  type SettingsError,
  type Subscription,
  type SubscriptionReason,
  ThreadError,
  type ThreadPullRequest,
  type UpdatedPullRequest,
} from "@glass/contracts"
import { Array as Arr, Context, DateTime, Effect, Layer, Match, Predicate, Stream } from "effect"
import { EventLog } from "./EventLog"
import { FollowedRepositories } from "./FollowedRepositories"
import { endedEvent, recorded } from "./gitHubEvents"
import { GitHubClient } from "./github/GitHubClient"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import {
  isRepositoryOf,
  type Mirror,
  mirroredPullRequest,
  mirroredRepositoryOf,
  PullRequestMirror,
} from "./PullRequestMirror"
import { type EndedState, endedNow, ENDING_TOLD_BY, openNow } from "./pullRequestNow"
import { SettingsStore } from "./SettingsStore"
import { decided, sourceOf, type Source } from "./Source"
import { Subscriptions, type SubscriptionState } from "./Subscriptions"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Transcripts } from "./Transcripts"
import type { Decision } from "./updateDecision"

const EVENTS_READ = 50

export interface NewPullRequestSubscription {
  readonly pullRequest: PullRequestRef | null
  readonly reasons: ReadonlyArray<SubscriptionReason>
  readonly note: string
}

export interface PullRequestDecision {
  readonly state: SubscriptionState
  readonly pullRequest: PullRequestRef
  readonly decision: Decision<PullRequestUpdateReason>
}

const subscribedNow = (
  { subscription, ended }: SubscriptionState,
  mirror: Mirror | undefined,
  own: ThreadPullRequest | undefined,
  readSince: DateTime.Utc | undefined,
) => {
  if (ended !== null) return { pullRequest: ended.pullRequest, now: endedNow(ended.state) }

  const pullRequest = subscription.subject.pullRequest ?? own?.ref

  if (mirror === undefined || pullRequest === undefined) return undefined

  const readAt = mirroredRepositoryOf(mirror, pullRequest)?.syncedAt

  if (readSince !== undefined && (readAt === undefined || DateTime.isLessThan(readAt, readSince)))
    return undefined

  const mirrored = mirroredPullRequest(mirror, pullRequest)

  return mirrored?.attention == null || mirrored.details === null
    ? undefined
    : {
        pullRequest: mirrored.ref,
        now: openNow({
          checks: mirrored.checks,
          failingChecks: mirrored.attention.failingChecks,
          mergeConflict: mirrored.attention.mergeConflict,
          details: mirrored.details,
        }),
      }
}

const isBehind = (reason: PullRequestUpdateReason, event: Event) =>
  Match.valueTags(reason, {
    FailingChecks: ({ head }) => Predicate.isTagged(event, "ChecksFailed") && event.head === head,
    ReviewFeedback: () => Predicate.isTagged(event, "ReviewFeedbackWaiting"),
    ChangesRequested: () => Predicate.isTagged(event, "ChangesRequested"),
    MergeConflict: () => Predicate.isTagged(event, "MergeConflictAppeared"),
    Merged: () => Predicate.isTagged(event, "PullRequestMerged"),
    Closed: () => Predicate.isTagged(event, "PullRequestClosed"),
  })

const eventsBehind = (
  reasons: ReadonlyArray<PullRequestUpdateReason>,
  recent: ReadonlyArray<LoggedEvent>,
) => reasons.flatMap((reason) => recent.find(({ event }) => isBehind(reason, event)) ?? [])

interface Due {
  readonly state: SubscriptionState
  readonly pullRequest: PullRequestRef
  readonly reasons: Arr.NonEmptyReadonlyArray<PullRequestUpdateReason>
}

const refuse = (message: string) => Effect.fail(new ThreadError({ message }))

const refuseEnded = (pullRequest: string, state: EndedState) =>
  refuse(`${pullRequest} has already ${state}, so there's nothing left to tell your Thread about.`)

const endedStateOf = ({ state }: ThreadPullRequest): EndedState | null => {
  if (Predicate.isTagged(state, "Open")) return null

  return Predicate.isTagged(state, "Merged") ? "merged" : "closed"
}

export class GitHubSource extends Context.Service<
  GitHubSource,
  {
    readonly source: Source
    readonly subscribe: (
      threadId: string,
      turnId: string | null,
      input: NewPullRequestSubscription,
    ) => Effect.Effect<Subscription, ThreadError | SettingsError | ConnectionError>
    readonly decisions: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestDecision>, ThreadError>
  }
>()("@glass/server/GitHubSource") {
  static readonly layer = Layer.effect(
    GitHubSource,
    Effect.gen(function* () {
      const subscriptions = yield* Subscriptions
      const followed = yield* FollowedRepositories
      const github = yield* GitHubClient
      const transcripts = yield* Transcripts
      const threadPullRequests = yield* ThreadPullRequests
      const mirror = yield* PullRequestMirror
      const events = yield* EventLog
      const settings = yield* SettingsStore

      const lookUp = (pullRequests: ReadonlyArray<PullRequestRef>) =>
        github
          .queuedPullRequests(pullRequests)
          .pipe(Effect.provideService(BackgroundGitHubRequest, true))

      const refuseOwnEnded = Effect.fnUntraced(function* (threadId: string) {
        const own = yield* threadPullRequests.ofThread(threadId)

        if (own === undefined) return

        const ended = endedStateOf(own)

        if (ended !== null) yield* refuseEnded(`Your Thread's PR #${own.ref.number}`, ended)
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

      const admitted = Effect.fnUntraced(function* (
        threadId: string,
        pullRequest: PullRequestRef | null,
      ) {
        if (pullRequest === null) {
          yield* refuseOwnEnded(threadId)

          return PullRequestSubject.make({ pullRequest: null })
        }

        return PullRequestSubject.make({ pullRequest: yield* followedPullRequest(pullRequest) })
      })

      const endAbout = (
        ending: ReadonlyArray<Subscription>,
        state: EndedState,
        pullRequest: PullRequestRef,
      ) =>
        subscriptions.endAbout(
          ending,
          PullRequestEnding.make({ state, pullRequest }),
          ENDING_TOLD_BY,
        )

      const endOwn = Effect.fnUntraced(function* (listed: ReadonlyArray<ThreadPullRequest>) {
        const ended = listed.flatMap((own) => {
          const state = endedStateOf(own)

          return state === null ? [] : [{ own, state }]
        })

        if (ended.length === 0) return

        const own = (yield* subscriptions.notEnded("github")).filter(
          ({ subject }) => subject.pullRequest === null,
        )

        yield* Effect.forEach(
          ended,
          ({ own: { threadId, ref }, state }) =>
            endAbout(
              own.filter((subscription) => subscription.threadId === threadId),
              state,
              ref,
            ),
          { discard: true },
        )
      })

      const endNamed = Effect.fnUntraced(function* (mirrored: Mirror | undefined) {
        if (mirrored === undefined) return

        const gone = Object.values(
          Arr.groupBy(
            (yield* subscriptions.notEnded("github")).flatMap((subscription) => {
              const { pullRequest } = subscription.subject

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

            const { state } = lookedUp
            const at = state === "merged" ? lookedUp.mergedAt : lookedUp.closedAt

            return events
              .record(
                "github",
                at === null ? [] : recorded([endedEvent(lookedUp.summary.ref, state, at)]),
              )
              .pipe(
                Effect.andThen(
                  endAbout(
                    group.map(({ subscription }) => subscription),
                    state,
                    group[0].pullRequest,
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
        Stream.zipLatest(seen, subscriptions.changes).pipe(
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

      const subscribedOf = Effect.fnUntraced(function* (
        threadId: string,
        states: ReadonlyArray<SubscriptionState>,
        readSince?: DateTime.Utc,
      ) {
        const mirrored = yield* mirror.saved
        const own = yield* threadPullRequests.ofThread(threadId)

        return states.flatMap((state) => {
          const subscribed = subscribedNow(state, mirrored, own, readSince)

          return subscribed === undefined
            ? []
            : [{ state, subject: referenceKey(subscribed.pullRequest), ...subscribed }]
        })
      })

      const updatedPullRequest = ({ state: { subscription }, pullRequest, reasons }: Due) =>
        events
          .list({
            limit: EVENTS_READ,
            about: { source: "github", subjects: [referenceKey(pullRequest)] },
          })
          .pipe(
            Effect.map(({ events: recent }) => recent),
            Effect.orElseSucceed((): ReadonlyArray<LoggedEvent> => []),
            Effect.map((recent): UpdatedPullRequest => ({
              subscriptionId: subscription.id,
              pullRequest,
              own: subscription.subject.pullRequest === null,
              reasons,
              note: subscription.note,
              events: eventsBehind(reasons, recent),
            })),
          )

      const update = (due: Arr.NonEmptyReadonlyArray<Due>) =>
        Effect.gen(function* () {
          const subjects = yield* Effect.forEach(due, updatedPullRequest)
          const { pullRequestUpdateNote: note } = yield* settings.read()

          return PullRequestUpdate.make({ source: "github", subjects, note })
        }).pipe(Effect.mapError(({ message }) => new ThreadError({ message })))

      return GitHubSource.of({
        source: sourceOf({
          name: "github",
          changes: [mirror.changes, threadPullRequests.watch()],
          now: subscribedOf,
          update,
        }),
        subscribe: (threadId, turnId, { pullRequest, reasons, note }) =>
          subscriptions.subscribe(threadId, turnId, {
            source: "github",
            subject: admitted(threadId, pullRequest),
            reasons,
            note,
          }),
        decisions: (threadId) =>
          Effect.gen(function* () {
            const states = yield* subscriptions.states(threadId, "github")

            return decided(
              yield* subscribedOf(threadId, states),
              yield* transcripts.lastMessageTurn(threadId),
            )
          }),
      })
    }),
  )
}

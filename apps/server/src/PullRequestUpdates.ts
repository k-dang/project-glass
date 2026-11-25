import {
  type Event,
  type LoggedEvent,
  type PullRequestRef,
  PullRequestUpdate,
  type PullRequestUpdateReason,
  referenceKey,
  type ThreadPullRequest,
  type UpdatedPullRequest,
} from "@glass/contracts"
import {
  Array as Arr,
  DateTime,
  Effect,
  Exit,
  Layer,
  Match,
  Option,
  Predicate,
  Ref,
  Stream,
} from "effect"
import { EventLog } from "./EventLog"
import { type Mirror, mirroredPullRequest, PullRequestMirror } from "./PullRequestMirror"
import { decide, PullRequestNow, sameTold } from "./pullRequestUpdateDecision"
import { SettingsStore } from "./SettingsStore"
import { type SubscriptionState, Subscriptions } from "./Subscriptions"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"
import { recordUnit } from "./wideEvents"

const EVENTS_READ = 50

interface Subscribed {
  readonly pullRequest: PullRequestRef
  readonly now: PullRequestNow
}

const subscribedTo = (
  { subscription, ended }: SubscriptionState,
  mirror: Mirror | undefined,
  own: ThreadPullRequest | undefined,
): Subscribed | undefined => {
  if (ended !== null)
    return { pullRequest: ended.pullRequest, now: PullRequestNow.Ended({ state: ended.state }) }

  const pullRequest = subscription.pullRequest ?? own?.ref

  if (mirror === undefined || pullRequest === undefined) return undefined

  const mirrored = mirroredPullRequest(mirror, pullRequest)

  return mirrored?.attention == null || mirrored.subscribed === null
    ? undefined
    : {
        pullRequest: mirrored.ref,
        now: PullRequestNow.Open({
          failingChecks: mirrored.attention.failingChecks,
          mergeConflict: mirrored.attention.mergeConflict,
          read: mirrored.subscribed,
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

export const PullRequestUpdates = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Threads
    const subscriptions = yield* Subscriptions
    const transcripts = yield* Transcripts
    const mirror = yield* PullRequestMirror
    const threadPullRequests = yield* ThreadPullRequests
    const settings = yield* SettingsStore
    const eventLog = yield* EventLog

    const recentEvents = (pullRequest: PullRequestRef) =>
      eventLog.list({ limit: EVENTS_READ, pullRequests: [pullRequest] }).pipe(
        Effect.map(({ events }) => events),
        Effect.orElseSucceed((): ReadonlyArray<LoggedEvent> => []),
      )

    const decided = Effect.fnUntraced(function* (threadId: string) {
      const states = yield* subscriptions.states(threadId)
      const mirrored = yield* mirror.saved
      const listed = yield* threadPullRequests.watch().pipe(Stream.runHead)
      const own = Option.getOrThrow(listed).find((candidate) => candidate.threadId === threadId)

      return states.flatMap((state) => {
        const subscribed = subscribedTo(state, mirrored, own)

        if (subscribed === undefined) return []

        const { pullRequest, now } = subscribed
        const before = state.toldAbout(pullRequest)

        return [
          { state, pullRequest, before, decision: decide(state.subscription.reasons, now, before) },
        ]
      })
    })

    const sendUpdate = (threadId: string) =>
      threads.whenIdle(threadId, (start) =>
        Effect.gen(function* () {
          const all = yield* decided(threadId)

          const told = all.flatMap(({ state, pullRequest, before, decision }) => {
            const ends = state.ended !== null && decision.reasons.length > 0

            return ends || !sameTold(decision.told, before)
              ? [{ subscriptionId: state.subscription.id, pullRequest, told: decision.told, ends }]
              : []
          })

          const updated = yield* Effect.forEach(
            all,
            ({ state: { subscription }, pullRequest, decision: { reasons } }) =>
              Arr.isReadonlyArrayNonEmpty(reasons)
                ? recentEvents(pullRequest).pipe(
                    Effect.map((recent): ReadonlyArray<UpdatedPullRequest> => [
                      {
                        subscriptionId: subscription.id,
                        pullRequest,
                        own: subscription.pullRequest === null,
                        reasons,
                        note: subscription.note,
                        events: eventsBehind(reasons, recent),
                      },
                    ]),
                  )
                : Effect.succeed([]),
          ).pipe(Effect.map(Arr.flatten))

          if (!Arr.isReadonlyArrayNonEmpty(updated)) {
            yield* subscriptions.recordTold(told)

            return
          }

          const { pullRequestUpdateNote: note } = yield* settings.read()
          const startedAt = yield* DateTime.now
          const started = yield* Ref.make<string | undefined>(undefined)

          yield* start(
            {
              message: "",
              images: [],
              context: PullRequestUpdate.make({ pullRequests: updated, note }),
              retriesDelivery: false,
            },
            (turnId) =>
              subscriptions.recordTold(told).pipe(Effect.andThen(Ref.set(started, turnId))),
          ).pipe(
            Effect.onExit(
              Effect.fnUntraced(function* (exit) {
                const turnId = yield* Ref.get(started)

                if (turnId === undefined && Exit.isSuccess(exit)) return

                yield* recordUnit("PullRequestUpdate", {
                  startedAt,
                  endedAt: yield* DateTime.now,
                  exit,
                  fields: {
                    thread_id: threadId,
                    turn_id: turnId,
                    pr: updated.map(({ pullRequest }) => referenceKey(pullRequest)).join(),
                    subscription_ids: updated.map(({ subscriptionId }) => subscriptionId).join(),
                    reasons: Arr.dedupe(
                      updated.flatMap(({ reasons }) => reasons.map(({ _tag }) => _tag)),
                    ).join(),
                  },
                })
                yield* subscriptions.toldChanged
              }),
            ),
          )
        }),
      )

    const sendUpdates = subscriptions.subscribedThreads.pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            sendUpdate(threadId).pipe(
              Effect.catch((cause) => Effect.logWarning("Couldn't send a PR update", cause)),
            ),
          { discard: true },
        ),
      ),
      Effect.catch((cause) => Effect.logWarning("Couldn't read the Subscriptions", cause)),
    )

    yield* Stream.mergeAll(
      [
        subscriptions.changes,
        mirror.changes,
        threadPullRequests.watch(),
        yield* transcripts.subscribeMaybeIdle,
      ].map((changed: Stream.Stream<unknown>) => Stream.as(changed, undefined)),
      { concurrency: "unbounded" },
    ).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => sendUpdates),
      Effect.forkScoped,
    )
  }),
)

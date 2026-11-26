import {
  type Event,
  type LoggedEvent,
  type PullRequestRef,
  PullRequestUpdate,
  type PullRequestUpdateReason,
  referenceKey,
  type Subscription,
  type UpdatedPullRequest,
} from "@glass/contracts"
import { Array as Arr, DateTime, Effect, Exit, Layer, Match, Predicate, Ref, Stream } from "effect"
import { EventLog } from "./EventLog"
import { PullRequestMirror } from "./PullRequestMirror"
import { sameTold } from "./pullRequestUpdateDecision"
import { SettingsStore } from "./SettingsStore"
import { changed, type SubscriptionDecision, subscriptionDecisions } from "./subscriptionDecisions"
import { Subscriptions, type ToldSubscription } from "./Subscriptions"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"
import { recordUnit } from "./wideEvents"

const EVENTS_READ = 50

const RUN_AT_ONCE = 3

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
  readonly subscription: Subscription
  readonly pullRequest: PullRequestRef
  readonly reasons: Arr.NonEmptyReadonlyArray<PullRequestUpdateReason>
}

const tells = ({ decision }: SubscriptionDecision) => decision.reasons.length > 0

const planned = (all: ReadonlyArray<SubscriptionDecision>, full: boolean) => {
  const sends = !full && all.some(tells)

  return {
    due: sends
      ? all.flatMap(({ state: { subscription }, pullRequest, decision }): ReadonlyArray<Due> =>
          Arr.isReadonlyArrayNonEmpty(decision.reasons)
            ? [{ subscription, pullRequest, reasons: decision.reasons }]
            : [],
        )
      : [],
    record: all.flatMap((decided): ReadonlyArray<ToldSubscription> => {
      const { state, pullRequest, before, decision } = decided
      const telling = tells(decided)

      if (telling && !sends) return []

      const ends = state.ended !== null && telling

      return ends || !sameTold(decision.told, before)
        ? [{ subscriptionId: state.subscription.id, pullRequest, told: decision.told, ends }]
        : []
    }),
  }
}

export const PullRequestUpdates = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* Threads
    const subscriptions = yield* Subscriptions
    const transcripts = yield* Transcripts
    const mirror = yield* PullRequestMirror
    const threadPullRequests = yield* ThreadPullRequests
    const settings = yield* SettingsStore
    const eventLog = yield* EventLog
    const decided = yield* subscriptionDecisions

    const updatedPullRequest = ({ subscription, pullRequest, reasons }: Due) =>
      eventLog.list({ limit: EVENTS_READ, pullRequests: [pullRequest] }).pipe(
        Effect.map(({ events }) => events),
        Effect.orElseSucceed((): ReadonlyArray<LoggedEvent> => []),
        Effect.map((recent): UpdatedPullRequest => ({
          subscriptionId: subscription.id,
          pullRequest,
          own: subscription.pullRequest === null,
          reasons,
          note: subscription.note,
          events: eventsBehind(reasons, recent),
        })),
      )

    const asUnitOfWork = <E, R>(
      threadId: string,
      updated: ReadonlyArray<UpdatedPullRequest>,
      send: (started: (turnId: string) => Effect.Effect<void>) => Effect.Effect<unknown, E, R>,
    ) =>
      Effect.gen(function* () {
        const startedAt = yield* DateTime.now
        const turn = yield* Ref.make<string | undefined>(undefined)

        yield* send((turnId) => Ref.set(turn, turnId)).pipe(
          Effect.onExit(
            Effect.fnUntraced(function* (exit) {
              const turnId = yield* Ref.get(turn)

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
              yield* subscriptions.announceChange
            }),
          ),
        )
      })

    const sendUpdate = (threadId: string, waits: Effect.Effect<void>) =>
      threads.whenIdle(threadId, (start) =>
        Effect.gen(function* () {
          const { all, lastMessageTurn } = yield* decided(threadId)

          const full =
            all.some(tells) && (yield* transcripts.runningPullRequestUpdates).length >= RUN_AT_ONCE

          const { due, record } = planned(all, full)

          if (!Arr.isReadonlyArrayNonEmpty(due)) {
            yield* subscriptions.recordTold(record, lastMessageTurn)

            if (full) yield* waits

            return
          }

          const updated = yield* Effect.forEach(due, updatedPullRequest)
          const { pullRequestUpdateNote: note } = yield* settings.read()

          yield* asUnitOfWork(threadId, updated, (started) =>
            start(
              {
                message: "",
                images: [],
                context: PullRequestUpdate.make({ pullRequests: updated, note }),
                retriesDelivery: false,
              },
              (turnId) =>
                subscriptions
                  .recordTold(record, lastMessageTurn)
                  .pipe(Effect.andThen(started(turnId))),
            ),
          )
        }),
      )

    const waiting = yield* Ref.make<ReadonlyArray<string>>([])

    const sendUpdates = Effect.gen(function* () {
      const subscribed = yield* subscriptions.subscribedThreads
      const inLine = (yield* Ref.get(waiting)).filter((threadId) => subscribed.includes(threadId))
      const next = yield* Ref.make<ReadonlyArray<string>>([])

      yield* Effect.forEach(
        [...inLine, ...subscribed.filter((threadId) => !inLine.includes(threadId))],
        (threadId) =>
          sendUpdate(threadId, Ref.update(next, Arr.append(threadId))).pipe(
            Effect.catch((cause) => Effect.logWarning("Couldn't send a PR update", cause)),
          ),
        { discard: true },
      )

      yield* Ref.set(waiting, yield* Ref.get(next))
    }).pipe(Effect.catch((cause) => Effect.logWarning("Couldn't read the Subscriptions", cause)))

    yield* changed([
      subscriptions.changes,
      mirror.changes,
      threadPullRequests.watch(),
      yield* transcripts.subscribeMaybeIdle,
    ]).pipe(
      Stream.runForEach(() => sendUpdates),
      Effect.forkScoped,
    )
  }),
)

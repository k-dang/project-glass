import {
  type Event,
  isGone,
  type LoggedEvent,
  type OpenReason,
  openReasons,
  type PullRequestRef,
  PullRequestUpdate,
  type PullRequestUpdateReason,
  referenceKey,
  subscriptionReasonOf,
  type Thread,
  type ThreadPullRequest,
  type UpdatedPullRequest,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
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

const RUN_AT_ONCE = 3

interface SubscribedNow {
  readonly pullRequest: PullRequestRef
  readonly now: PullRequestNow
}

const subscribedNow = (
  { subscription, ended }: SubscriptionState,
  mirror: Mirror | undefined,
  own: ThreadPullRequest | undefined,
): SubscribedNow | undefined => {
  if (ended !== null)
    return { pullRequest: ended.pullRequest, now: PullRequestNow.Ended({ state: ended.state }) }

  const pullRequest = subscription.pullRequest ?? own?.ref

  if (mirror === undefined || pullRequest === undefined) return undefined

  const mirrored = mirroredPullRequest(mirror, pullRequest)

  return mirrored?.attention == null || mirrored.details === null
    ? undefined
    : {
        pullRequest: mirrored.ref,
        now: PullRequestNow.Open({
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

const changed = (changes: ReadonlyArray<Stream.Stream<unknown, unknown>>) =>
  Stream.mergeAll(
    changes.map((change) =>
      change.pipe(
        Stream.as(undefined),
        Stream.catch(() => Stream.empty),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(Stream.buffer({ capacity: 1, strategy: "sliding" }))

export interface PullRequestStanding {
  readonly pullRequest: PullRequestRef
  readonly reason: OpenReason
  readonly thread: Thread
  readonly state: "handling" | "tried"
}

export class PullRequestUpdates extends Context.Service<
  PullRequestUpdates,
  {
    readonly standings: Stream.Stream<ReadonlyArray<PullRequestStanding>>
  }
>()("@glass/server/PullRequestUpdates") {
  static readonly layer = Layer.effect(
    PullRequestUpdates,
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
        const own = yield* threadPullRequests.ofThread(threadId)
        const lastMessageTurn = yield* transcripts.lastMessageTurn(threadId)

        const all = states.flatMap((state) => {
          const subscribed = subscribedNow(state, mirrored, own)

          if (subscribed === undefined) return []

          const { pullRequest, now } = subscribed
          const before = state.toldAbout(pullRequest, lastMessageTurn)

          return [
            {
              state,
              pullRequest,
              before,
              decision: decide(state.subscription.reasons, now, before),
            },
          ]
        })

        return { all, lastMessageTurn }
      })

      const sendUpdate = (threadId: string, waits: Effect.Effect<void>) =>
        threads.whenIdle(threadId, (start) =>
          Effect.gen(function* () {
            const { all, lastMessageTurn } = yield* decided(threadId)

            const toldAnew = all.flatMap(({ state, pullRequest, before, decision }) => {
              const tells = decision.reasons.length > 0
              const ends = state.ended !== null && tells

              return ends || !sameTold(decision.told, before)
                ? [
                    {
                      tells,
                      told: {
                        subscriptionId: state.subscription.id,
                        pullRequest,
                        told: decision.told,
                        ends,
                      },
                    },
                  ]
                : []
            })

            const toldBySending = toldAnew.map(({ told }) => told)

            const toldWithoutSending = toldAnew.flatMap(({ tells, told }) => (tells ? [] : [told]))

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
              yield* subscriptions.recordTold(toldWithoutSending, lastMessageTurn)

              return
            }

            if ((yield* transcripts.runningPullRequestUpdates).length >= RUN_AT_ONCE) {
              yield* subscriptions.recordTold(toldWithoutSending, lastMessageTurn)
              yield* waits

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
                subscriptions
                  .recordTold(toldBySending, lastMessageTurn)
                  .pipe(Effect.andThen(Ref.set(started, turnId))),
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
                  yield* subscriptions.announceChange
                }),
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

      const standingsOf = Effect.fnUntraced(function* (
        thread: Thread,
        running: PullRequestUpdate | undefined,
      ) {
        const { all } = yield* decided(thread.id)

        return all.flatMap(({ state: { subscription }, pullRequest, decision }) =>
          openReasons.flatMap((reason): ReadonlyArray<PullRequestStanding> => {
            const standing = decision.standing[reason]

            if (standing === null) return []

            const beingTold =
              running?.pullRequests.some(
                ({ subscriptionId, reasons }) =>
                  subscriptionId === subscription.id &&
                  reasons.some(({ _tag }) => subscriptionReasonOf[_tag] === reason),
              ) === true

            return [
              {
                pullRequest,
                reason,
                thread,
                state:
                  standing === "due" || (standing === "told" && beingTold) ? "handling" : "tried",
              },
            ]
          }),
        )
      })

      const standings = Effect.gen(function* () {
        const listed = Option.getOrThrow(yield* threads.watch().pipe(Stream.runHead))
        const running = yield* transcripts.runningPullRequestUpdates

        return yield* Effect.forEach(yield* subscriptions.subscribedThreads, (threadId) => {
          const thread = listed.find(({ id }) => id === threadId)

          return thread === undefined || (thread.sandbox !== null && isGone(thread.sandbox.reach))
            ? Effect.succeed([])
            : standingsOf(thread, running.find((update) => update.threadId === threadId)?.update)
        }).pipe(Effect.map(Arr.flatten))
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't read what subscribed Threads are doing", cause).pipe(
            Effect.as<ReadonlyArray<PullRequestStanding>>([]),
          ),
        ),
      )

      return PullRequestUpdates.of({
        standings: Stream.suspend(() =>
          changed([
            subscriptions.changes,
            mirror.changes,
            threadPullRequests.watch(),
            threads.watch(),
            threads.keptGoing,
            transcripts.running,
          ]).pipe(Stream.mapEffect(() => standings)),
        ),
      })
    }),
  )
}

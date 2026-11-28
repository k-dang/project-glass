import {
  AgentReviewFailedEvent,
  AgentReviewFinishedEvent,
  type Event,
  finishedReview,
  type PullRequestRef,
  ThreadFailedEvent,
  ThreadFinishedEvent,
  ThreadWaitingEvent,
  type TurnEnding,
} from "@glass/contracts"
import { DateTime, Effect, Layer, Match, Option, Predicate, Stream } from "effect"
import { AgentReviews } from "./AgentReviews"
import { EventLog, type NewEvent } from "./EventLog"
import { StartedWork } from "./StartedWork"
import { Subscriptions } from "./Subscriptions"
import { Threads } from "./Threads"
import { type EndedUpdate, Transcripts } from "./Transcripts"

const failureOf = (ending: TurnEnding) =>
  Match.value(ending).pipe(
    Match.tagsExhaustive({
      Done: () => null,
      Stopped: () => null,
      Failed: ({ reason }) => reason,
      CutOff: () => "Glass lost the agent while it worked.",
      Interrupted: () => "Glass quit while it worked.",
    }),
  )

interface Covered<Subject> {
  readonly subject: Subject
  readonly since: DateTime.Utc
}

const earliest = <Subject>(
  covered: Map<string, Covered<Subject>>,
  key: string,
  next: Covered<Subject>,
) => {
  const known = covered.get(key)

  if (known === undefined || DateTime.isLessThan(next.since, known.since)) covered.set(key, next)
}

type ToldEvent = Extract<
  Event,
  { readonly _tag: "ThreadFinished" | "ThreadFailed" | "AgentReviewFinished" }
>

const isTold = (event: Event): event is ToldEvent =>
  Predicate.isTagged(event, "ThreadFinished") ||
  Predicate.isTagged(event, "ThreadFailed") ||
  Predicate.isTagged(event, "AgentReviewFinished")

export const toldIn = (last: EndedUpdate | null): ReadonlyArray<ToldEvent> =>
  last === null || Predicate.isTagged(last.ended.ending, "Failed")
    ? []
    : last.update.subscriptions.flatMap(({ events }) =>
        events.flatMap(({ event }) => (isTold(event) ? [event] : [])),
      )

export const GlassSource = Layer.effectDiscard(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions
    const eventLog = yield* EventLog
    const transcripts = yield* Transcripts
    const threads = yield* Threads
    const agentReviews = yield* AgentReviews
    const startedWork = yield* StartedWork

    const covered = subscriptions.about("glass").pipe(
      Effect.map((states) => {
        const ofThreads = new Map<string, Covered<string>>()
        const ofReviews = new Map<string, Covered<PullRequestRef>>()

        for (const { subject, subjectKey, createdAt: since } of states)
          Match.value(subject).pipe(
            Match.tagsExhaustive({
              Thread: ({ threadId }) =>
                earliest(ofThreads, subjectKey, { subject: threadId, since }),
              AgentReview: ({ pullRequest }) =>
                earliest(ofReviews, subjectKey, { subject: pullRequest, since }),
              PullRequest: () => undefined,
            }),
          )

        return { ofThreads, ofReviews }
      }),
    )

    const threadEvents = Effect.fnUntraced(function* (
      ofThreads: ReadonlyMap<string, Covered<string>>,
    ) {
      if (ofThreads.size === 0) return []

      const [listed, ends, waiting] = yield* Effect.all(
        [
          threads.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
          transcripts.lastEnds([...ofThreads.keys()]),
          transcripts.waitingNow,
        ],
        { concurrency: "unbounded" },
      )

      return listed.flatMap(({ id: threadId, name }): ReadonlyArray<NewEvent> => {
        const found = ofThreads.get(threadId)

        if (found === undefined) return []

        const after = (at: DateTime.Utc) => DateTime.isGreaterThan(at, found.since)

        const asked = (waiting.get(threadId) ?? []).flatMap(({ part, since }) =>
          after(since)
            ? [
                {
                  subject: threadId,
                  once: `waiting:${threadId}:${part.requestId}`,
                  event: ThreadWaitingEvent.make({ threadId, name, requestId: part.requestId }),
                },
              ]
            : [],
        )

        const ended = ends.get(threadId)

        if (ended === undefined || !after(ended.at) || Predicate.isTagged(ended.ending, "Stopped"))
          return asked

        const reason = failureOf(ended.ending)
        const turn = { threadId, name, endedAt: ended.at }

        return [
          ...asked,
          {
            subject: threadId,
            once: `ended:${threadId}:${DateTime.formatIso(ended.at)}`,
            event:
              reason === null
                ? ThreadFinishedEvent.make(turn)
                : ThreadFailedEvent.make({ ...turn, reason }),
          },
        ]
      })
    })

    const reviewEvents = (ofReviews: ReadonlyMap<string, Covered<PullRequestRef>>) =>
      Effect.forEach(
        ofReviews,
        ([key, { subject: pullRequest, since }]) =>
          Effect.gen(function* () {
            const state = yield* agentReviews
              .watch(pullRequest)
              .pipe(Stream.runHead, Effect.map(Option.getOrThrow))

            const written = finishedReview(state)

            if (written !== null)
              return DateTime.isGreaterThan(written.writtenAt, since)
                ? [
                    {
                      subject: key,
                      once: `written:${key}:${DateTime.formatIso(written.writtenAt)}`,
                      event: AgentReviewFinishedEvent.make({
                        pullRequest,
                        writtenAt: written.writtenAt,
                      }),
                    },
                  ]
                : []

            if (state.job.status !== "failed") return []

            const startedAt = (yield* startedWork.agentReviewStartedAt(pullRequest)) ?? since

            return [
              {
                subject: key,
                once: `failed:${key}:${DateTime.formatIso(startedAt)}`,
                event: AgentReviewFailedEvent.make({
                  pullRequest,
                  reason: state.job.reason.message,
                }),
              },
            ]
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't read a started Agent review", cause).pipe(
                Effect.as<ReadonlyArray<NewEvent>>([]),
              ),
            ),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((found) => found.flat()))

    const report = Effect.gen(function* () {
      const { ofThreads, ofReviews } = yield* covered

      const [fromThreads, fromReviews] = yield* Effect.all(
        [threadEvents(ofThreads), reviewEvents(ofReviews)],
        { concurrency: "unbounded" },
      )

      yield* eventLog.record("glass", [...fromThreads, ...fromReviews])
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Couldn't report on started work", cause)),
      Effect.withSpan("GlassSource.report", { root: true }),
    )

    const changes = subscriptions.changes.pipe(
      Stream.mapEffect(() => covered),
      Stream.switchMap(({ ofThreads, ofReviews }) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const ended = yield* transcripts.subscribeEnded

            return Stream.mergeAll(
              [
                Stream.succeed(undefined),
                ended.pipe(Stream.filter((threadId) => ofThreads.has(threadId))),
                transcripts.waiting.pipe(
                  Stream.map((waiting) =>
                    [...ofThreads.keys()].map((threadId) => waiting.get(threadId)),
                  ),
                  Stream.changesWith((a, b) => a.every((one, index) => one === b[index])),
                ),
                ...[...ofReviews.values()].map(({ subject }) =>
                  agentReviews.watch(subject).pipe(Stream.catch(() => Stream.empty)),
                ),
              ].map((change: Stream.Stream<unknown>) => Stream.as(change, undefined)),
              { concurrency: "unbounded" },
            )
          }),
        ),
      ),
      Stream.catch((cause) =>
        Stream.fromEffect(Effect.logWarning("Stopped following started work", cause)),
      ),
    )

    yield* changes.pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEach(() => report),
      Effect.forkScoped,
    )

    const markSeen = (event: ToldEvent) =>
      Match.value(event).pipe(
        Match.tagsExhaustive({
          ThreadFinished: ({ threadId, endedAt }) => transcripts.markSeen(threadId, endedAt),
          ThreadFailed: ({ threadId, endedAt }) => transcripts.markSeen(threadId, endedAt),
          AgentReviewFinished: ({ pullRequest, writtenAt }) =>
            agentReviews.markIncludedInStartedWorkUpdate(pullRequest, writtenAt),
        }),
      )

    const markToldBy = (threadId: string) =>
      transcripts.lastEndedUpdate(threadId).pipe(
        Effect.flatMap((last) => Effect.forEach(toldIn(last), markSeen, { discard: true })),
        Effect.catch((cause) => Effect.logWarning("Couldn't mark told work seen", cause)),
      )

    yield* (yield* transcripts.subscribeEnded).pipe(
      Stream.runForEach(markToldBy),
      Effect.forkScoped,
    )
  }),
)

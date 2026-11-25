import {
  Thread,
  ThreadError,
  type AgentReviewFailure,
  ThreadOutcome,
  type AgentReviewState,
  AgentReviewOutcome,
  finishedReview,
  PullRequestRef,
  type WorkOutcome,
  TurnEnd,
  type TurnEnding,
  StartedWorkUpdate,
} from "@glass/contracts"
import {
  Array as Arr,
  Context,
  DateTime,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type Statement } from "effect/sql"
import { AgentReviews } from "./AgentReviews"
import { Questions } from "./Questions"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"

const StartedState = Schema.Literals(["running", "waiting", "finished", "failed"]).annotate({
  description:
    "running: still working. waiting: has a question for the user open, or waits for them to answer a Permission request, even after its Turn ended. finished: done, or stopped by the user. failed: ended in an error, or Glass quit while it worked.",
})

type StartedState = typeof StartedState.Type

const startedFields = {
  state: StartedState,
  askedWith: Schema.NullOr(Schema.String).annotate({
    description: "The user's message that asked for it, when known.",
  }),
  startedAt: Schema.DateTimeUtcFromString,
}

const StartedThread = Schema.TaggedStruct("Thread", {
  thread: Thread,
  ...startedFields,
})

const StartedAgentReview = Schema.TaggedStruct("AgentReview", {
  pullRequest: PullRequestRef,
  ...startedFields,
})

export const StartedItem = Schema.Union([StartedThread, StartedAgentReview])

const startedWorkUpdateFields = {
  started_work_update_outcome_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  startedWorkUpdate: Schema.NullOr(Schema.fromJsonString(StartedWorkUpdate)),
  startedWorkUpdateEnded: Schema.NullOr(Schema.fromJsonString(TurnEnd)),
}

const ThreadRow = Schema.Struct({
  thread_id: Schema.String,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...startedWorkUpdateFields,
})

type ThreadRow = typeof ThreadRow.Type

const ReviewRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...startedWorkUpdateFields,
})

type ReviewRow = typeof ReviewRow.Type

const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow))

const decodeReviewRows = Schema.decodeUnknownEffect(Schema.Array(ReviewRow))

const decodeStarters = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ started_by: Schema.String })),
)

const pullRequestOf = ({ owner, repo, number }: ReviewRow) =>
  new PullRequestRef({ owner, repo, number })

export interface Starter {
  readonly startedBy: string
  readonly sessionId: string
}

interface PendingOutcome {
  readonly work: WorkOutcome
  readonly at: DateTime.Utc
}

const endingReason = (ending: TurnEnding) =>
  Match.value(ending).pipe(
    Match.tagsExhaustive({
      Done: () => null,
      Stopped: () => null,
      Failed: ({ reason }) => reason,
      CutOff: () => "Glass lost the agent while it worked.",
      Interrupted: () => "Glass quit while it worked.",
    }),
  )

const ifNew = (
  row: ThreadRow | ReviewRow,
  at: DateTime.Utc,
  work: WorkOutcome,
): ReadonlyArray<PendingOutcome> =>
  DateTime.isGreaterThanOrEqualTo(at, row.started_at) &&
  (row.started_work_update_outcome_at === null ||
    DateTime.isGreaterThan(at, row.started_work_update_outcome_at))
    ? [{ work, at }]
    : []

const storageFailure = () =>
  new ThreadError({ message: "Couldn't read or save what the Global chat or a Thread started." })

const endingState = (ending: TurnEnding): StartedState =>
  Match.value(ending).pipe(
    Match.tagsExhaustive({
      Done: () => "finished" as const,
      Stopped: () => "finished" as const,
      Failed: () => "failed" as const,
      CutOff: () => "failed" as const,
      Interrupted: () => "failed" as const,
    }),
  )

const waitingSince = (
  requests: ReadonlyMap<string, ReadonlyArray<{ readonly since: DateTime.Utc }>>,
  asked: ReadonlyMap<string, ReadonlyArray<{ readonly since: DateTime.Utc }>>,
) => {
  const since = new Map<string, Arr.NonEmptyArray<DateTime.Utc>>()

  for (const waiting of [requests, asked])
    for (const [threadId, items] of waiting)
      for (const { since: at } of items) {
        const known = since.get(threadId)

        if (known === undefined) since.set(threadId, [at])
        else known.push(at)
      }

  return since
}

const threadState = (ended: TurnEnd | undefined, waiting: boolean): StartedState => {
  if (waiting) return "waiting"

  return ended === undefined ? "running" : endingState(ended.ending)
}

const reviewState = (state: AgentReviewState): StartedState => {
  if (state.job.status === "waiting" || state.job.status === "reviewing") return "running"

  return finishedReview(state) === null ? "failed" : "finished"
}

const saved = (what: string) => (statement: Effect.Effect<unknown, unknown>) =>
  statement.pipe(
    Effect.tapError((cause) => Effect.logWarning(`Couldn't save ${what}`, cause)),
    Effect.mapError(storageFailure),
    Effect.asVoid,
  )

export class StartedWork extends Context.Service<
  StartedWork,
  {
    readonly linkThread: (
      starter: Starter,
      threadId: string,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, ThreadError>
    readonly startedAgentReview: (
      starter: Starter,
      pullRequest: PullRequestRef,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, ThreadError>
    readonly list: (
      startedBy: string,
    ) => Effect.Effect<ReadonlyArray<typeof StartedItem.Type>, ThreadError | AgentReviewFailure>
    readonly pendingOutcomes: (
      startedBy: string,
    ) => Effect.Effect<ReadonlyArray<PendingOutcome>, ThreadError | AgentReviewFailure>
    readonly recordStartedWorkUpdate: (
      startedBy: string,
      turnId: string,
      outcomes: ReadonlyArray<PendingOutcome>,
    ) => Effect.Effect<void, ThreadError>
    readonly reconcileStartedWorkUpdates: (
      startedBy: string,
    ) => Effect.Effect<void, ThreadError | AgentReviewFailure>
    readonly starters: Effect.Effect<ReadonlyArray<string>, ThreadError>
    readonly changes: Stream.Stream<void>
  }
>()("@glass/server/StartedWork") {
  static readonly layer = Layer.effect(
    StartedWork,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threads = yield* Threads
      const agentReviews = yield* AgentReviews
      const transcripts = yield* Transcripts
      const questions = yield* Questions
      const recorded = yield* SubscriptionRef.make(0)

      const rowsMatching = (matching: Statement.Fragment) =>
        Effect.all(
          {
            threadRows: sql`
              SELECT c.thread_id, c.asked_with, c.started_at, c.started_work_update_outcome_at,
                t.context AS startedWorkUpdate, t.ended AS startedWorkUpdateEnded
              FROM started_thread c LEFT JOIN thread_turn t ON t.id = c.started_work_update_turn_id
              WHERE ${matching}
            `.pipe(Effect.flatMap(decodeThreadRows)),
            reviewRows: sql`
              SELECT c.owner, c.repo, c.number, c.asked_with, c.started_at, c.started_work_update_outcome_at,
                t.context AS startedWorkUpdate, t.ended AS startedWorkUpdateEnded
              FROM started_agent_review c LEFT JOIN thread_turn t ON t.id = c.started_work_update_turn_id
              WHERE ${matching}
            `.pipe(Effect.flatMap(decodeReviewRows)),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(storageFailure))

      const rowsOf = (startedBy: string) => rowsMatching(sql`c.started_by = ${startedBy}`)

      const allRows = rowsMatching(sql.and([]))

      const threadsOf = (threadRows: ReadonlyArray<ThreadRow>) =>
        Effect.gen(function* () {
          const [listed, ends, requests, asked] = yield* Effect.all(
            [
              threads.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
              transcripts.lastEnds(threadRows.map(({ thread_id }) => thread_id)),
              transcripts.waitingNow,
              questions.openByThread.pipe(
                Stream.runHead,
                Effect.map(Option.getOrElse(() => new Map())),
              ),
            ],
            { concurrency: "unbounded" },
          )

          const waiting = waitingSince(requests, asked)

          const byId = new Map(listed.map((thread) => [thread.id, thread]))

          const started = threadRows.flatMap((row) => {
            const thread = byId.get(row.thread_id)

            return thread === undefined ? [] : [{ row, thread }]
          })

          return { started, ends, waiting }
        })

      const reviewNow = (row: ReviewRow) =>
        agentReviews.watch(pullRequestOf(row)).pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      const changedRows = SubscriptionRef.update(recorded, (count) => count + 1)

      const changes = SubscriptionRef.changes(recorded).pipe(
        Stream.switchMap(() =>
          Stream.unwrap(
            Effect.gen(function* () {
              const ended = yield* transcripts.subscribeEnded
              const { threadRows, reviewRows } = yield* allRows

              const threadIds = threadRows.map(({ thread_id }) => thread_id)

              return Stream.mergeAll(
                [
                  ended.pipe(Stream.filter((threadId) => threadIds.includes(threadId))),
                  transcripts.waiting.pipe(
                    Stream.map((waiting) => threadIds.map((threadId) => waiting.get(threadId))),
                    Stream.changesWith(Arr.makeEquivalence((a, b) => a === b)),
                  ),
                  questions.openByThread.pipe(
                    Stream.map((byThread) =>
                      threadIds.map((threadId) =>
                        (byThread.get(threadId) ?? []).map(({ id }) => id),
                      ),
                    ),
                    Stream.changesWith(
                      Arr.makeEquivalence(Arr.makeEquivalence<string>((a, b) => a === b)),
                    ),
                  ),
                  ...reviewRows.map((row) =>
                    agentReviews.watch(pullRequestOf(row)).pipe(Stream.catch(() => Stream.empty)),
                  ),
                ].map((changed: Stream.Stream<unknown>) => Stream.as(changed, undefined)),
                { concurrency: "unbounded" },
              )
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning(
                  "Couldn't read what the Global chat or a Thread started",
                  cause,
                ).pipe(Effect.as(Stream.empty)),
              ),
            ),
          ),
        ),
      )

      return StartedWork.of({
        linkThread: ({ startedBy, sessionId }, threadId, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)

            yield* sql`
              INSERT INTO started_thread (started_by, thread_id, asked_with, started_at)
              VALUES (${startedBy}, ${threadId}, ${askedWith}, ${startedAt})
              ON CONFLICT DO NOTHING
            `.pipe(saved("a started Thread"))
            yield* changedRows
          }),
        startedAgentReview: ({ startedBy, sessionId }, { owner, repo, number }, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)

            yield* sql`
              INSERT INTO started_agent_review
                (started_by, owner, repo, number, asked_with, started_at)
              VALUES (${startedBy}, ${owner}, ${repo}, ${number}, ${askedWith}, ${startedAt})
              ON CONFLICT DO UPDATE
                SET asked_with = excluded.asked_with, started_at = excluded.started_at,
                  started_work_update_outcome_at = NULL, started_work_update_turn_id = NULL
            `.pipe(saved("a started Agent review"))
            yield* changedRows
          }),
        list: (startedBy) =>
          Effect.gen(function* () {
            const { threadRows, reviewRows } = yield* rowsOf(startedBy)
            const { started, ends, waiting } = yield* threadsOf(threadRows)

            const reviews = yield* Effect.forEach(
              reviewRows,
              (row) =>
                reviewNow(row).pipe(
                  Effect.map((state) =>
                    StartedAgentReview.make({
                      pullRequest: pullRequestOf(row),
                      state: reviewState(state),
                      askedWith: row.asked_with,
                      startedAt: row.started_at,
                    }),
                  ),
                ),
              { concurrency: "unbounded" },
            )

            const threadItems = started.map(({ row, thread }) =>
              StartedThread.make({
                thread,
                state: threadState(ends.get(thread.id), waiting.has(thread.id)),
                askedWith: row.asked_with,
                startedAt: row.started_at,
              }),
            )

            return [...threadItems, ...reviews].toSorted((a, b) =>
              DateTime.Order(a.startedAt, b.startedAt),
            )
          }),
        pendingOutcomes: (startedBy) =>
          Effect.gen(function* () {
            const { threadRows, reviewRows } = yield* rowsOf(startedBy)
            const { started, ends, waiting } = yield* threadsOf(threadRows)

            const fromThreads = started.flatMap(
              ({ row, thread }): ReadonlyArray<PendingOutcome> => {
                const subject = {
                  threadId: thread.id,
                  name: thread.name,
                  askedWith: row.asked_with,
                }

                const since = waiting.get(thread.id)

                if (since !== undefined) {
                  const latest = Arr.max(since, DateTime.Order)

                  return ifNew(
                    row,
                    latest,
                    ThreadOutcome.make({ ...subject, outcome: "waiting", reason: null }),
                  )
                }

                const ended = ends.get(thread.id)

                if (ended === undefined || Predicate.isTagged(ended.ending, "Stopped")) return []

                return ifNew(
                  row,
                  ended.at,
                  ThreadOutcome.make({
                    ...subject,
                    outcome: endingState(ended.ending) === "failed" ? "failed" : "finished",
                    reason: endingReason(ended.ending),
                  }),
                )
              },
            )

            const fromReviews = yield* Effect.forEach(
              reviewRows,
              (row) =>
                reviewNow(row).pipe(
                  Effect.map((state): ReadonlyArray<PendingOutcome> => {
                    const subject = { pullRequest: pullRequestOf(row), askedWith: row.asked_with }
                    const written = finishedReview(state)
                    const { job } = state

                    if (written !== null)
                      return ifNew(
                        row,
                        written.writtenAt,
                        AgentReviewOutcome.make({ ...subject, outcome: "finished", reason: null }),
                      )

                    return job.status === "failed"
                      ? ifNew(
                          row,
                          row.started_at,
                          AgentReviewOutcome.make({
                            ...subject,
                            outcome: "failed",
                            reason: job.reason.message,
                          }),
                        )
                      : []
                  }),
                ),
              { concurrency: "unbounded" },
            )

            return [...fromThreads, ...fromReviews.flat()]
          }),
        recordStartedWorkUpdate: (startedBy, turnId, outcomes) =>
          Effect.forEach(
            outcomes,
            ({ work, at }) => {
              const outcomeAt = DateTime.formatIso(at)

              return Match.value(work).pipe(
                Match.tagsExhaustive({
                  Thread: ({ threadId }) =>
                    sql`
                      UPDATE started_thread SET started_work_update_outcome_at = ${outcomeAt}, started_work_update_turn_id = ${turnId}
                      WHERE started_by = ${startedBy} AND thread_id = ${threadId}
                    `.pipe(saved("a Started work update's covered outcomes")),
                  AgentReview: ({ pullRequest }) =>
                    sql`
                      UPDATE started_agent_review SET started_work_update_outcome_at = ${outcomeAt}, started_work_update_turn_id = ${turnId}
                      WHERE started_by = ${startedBy} AND owner = ${pullRequest.owner}
                        AND repo = ${pullRequest.repo} AND number = ${pullRequest.number}
                    `.pipe(saved("a Started work update's covered outcomes")),
                }),
              )
            },
            { discard: true },
          ),
        reconcileStartedWorkUpdates: Effect.fn("StartedWork.reconcileStartedWorkUpdates")(
          function* (startedBy) {
            const { threadRows, reviewRows } = yield* rowsOf(startedBy)

            for (const row of [...threadRows, ...reviewRows]) {
              const context = row.startedWorkUpdate
              const ended = row.startedWorkUpdateEnded

              if (
                context === null ||
                row.started_work_update_outcome_at === null ||
                ended === null ||
                Predicate.isTagged(ended.ending, "Failed")
              )
                continue

              if ("thread_id" in row) {
                const matched = context.work.find(
                  (work) => Predicate.isTagged(work, "Thread") && work.threadId === row.thread_id,
                )

                if (matched !== undefined && matched.outcome !== "waiting")
                  yield* threads.markTurnSeen(row.thread_id, row.started_work_update_outcome_at)
              } else {
                const pr = pullRequestOf(row)

                const matched = context.work.find(
                  (work) =>
                    Predicate.isTagged(work, "AgentReview") &&
                    work.pullRequest.owner === pr.owner &&
                    work.pullRequest.repo === pr.repo &&
                    work.pullRequest.number === pr.number,
                )

                if (matched?.outcome === "finished")
                  yield* agentReviews.markIncludedInStartedWorkUpdate(
                    pr,
                    row.started_work_update_outcome_at,
                  )
              }
            }
          },
        ),
        starters: sql`
          SELECT started_by FROM started_thread
          UNION SELECT started_by FROM started_agent_review
        `.pipe(
          Effect.flatMap(decodeStarters),
          Effect.map((found) => found.map(({ started_by }) => started_by)),
          Effect.mapError(storageFailure),
        ),
        changes,
      })
    }),
  )
}

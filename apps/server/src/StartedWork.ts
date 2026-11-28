import {
  AgentReviewSubject,
  type AgentReviewFailure,
  type AgentReviewState,
  finishedReview,
  PullRequestRef,
  Thread,
  ThreadError,
  ThreadSubject,
  type TurnEnd,
  type TurnEnding,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Match, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { AgentReviews } from "./AgentReviews"
import { Subscriptions } from "./Subscriptions"
import { Threads } from "./Threads"
import { Transcripts } from "./Transcripts"

const StartedState = Schema.Literals(["running", "waiting", "finished", "failed"]).annotate({
  description:
    "running: still working. waiting: waits for the user to answer a Question or Permission request. finished: done, or stopped by the user. failed: ended in an error, or Glass quit while it worked.",
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

const ThreadRow = Schema.Struct({
  thread_id: Schema.String,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
})

type ThreadRow = typeof ThreadRow.Type

const ReviewRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
})

type ReviewRow = typeof ReviewRow.Type

const decodeThreadRows = Schema.decodeUnknownEffect(Schema.Array(ThreadRow))

const decodeReviewRows = Schema.decodeUnknownEffect(Schema.Array(ReviewRow))

const decodeStartedAt = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ startedAt: Schema.NullOr(Schema.DateTimeUtcFromString) })),
)

const pullRequestOf = ({ owner, repo, number }: ReviewRow) =>
  new PullRequestRef({ owner, repo, number })

export interface Starter {
  readonly startedBy: string
  readonly sessionId: string
}

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
    readonly agentReviewStartedAt: (
      pullRequest: PullRequestRef,
    ) => Effect.Effect<DateTime.Utc | null, ThreadError>
  }
>()("@glass/server/StartedWork") {
  static readonly layer = Layer.effect(
    StartedWork,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const threads = yield* Threads
      const agentReviews = yield* AgentReviews
      const transcripts = yield* Transcripts
      const subscriptions = yield* Subscriptions

      const rowsOf = (startedBy: string) =>
        Effect.all(
          {
            threadRows: sql`
              SELECT thread_id, asked_with, started_at FROM started_thread
              WHERE started_by = ${startedBy}
            `.pipe(Effect.flatMap(decodeThreadRows)),
            reviewRows: sql`
              SELECT owner, repo, number, asked_with, started_at FROM started_agent_review
              WHERE started_by = ${startedBy}
            `.pipe(Effect.flatMap(decodeReviewRows)),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(storageFailure))

      const reviewNow = (row: ReviewRow) =>
        agentReviews.watch(pullRequestOf(row)).pipe(Stream.runHead, Effect.map(Option.getOrThrow))

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
            yield* subscriptions.follow(
              startedBy,
              ThreadSubject.make({ threadId }),
              askedWith ?? "",
              actedAt,
            )
          }),
        startedAgentReview: ({ startedBy, sessionId }, pullRequest, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)
            const { owner, repo, number } = pullRequest

            yield* sql`
              INSERT INTO started_agent_review
                (started_by, owner, repo, number, asked_with, started_at)
              VALUES (${startedBy}, ${owner}, ${repo}, ${number}, ${askedWith}, ${startedAt})
              ON CONFLICT DO UPDATE
                SET asked_with = excluded.asked_with, started_at = excluded.started_at
            `.pipe(saved("a started Agent review"))
            yield* subscriptions.follow(
              startedBy,
              AgentReviewSubject.make({ pullRequest }),
              askedWith ?? "",
              actedAt,
            )
          }),
        list: (startedBy) =>
          Effect.gen(function* () {
            const { threadRows, reviewRows } = yield* rowsOf(startedBy)

            const [listed, ends, waiting] = yield* Effect.all(
              [
                threads.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
                transcripts.lastEnds(threadRows.map(({ thread_id }) => thread_id)),
                transcripts.waitingNow,
              ],
              { concurrency: "unbounded" },
            )

            const byId = new Map(listed.map((thread) => [thread.id, thread]))

            const threadItems = threadRows.flatMap((row) => {
              const thread = byId.get(row.thread_id)

              return thread === undefined
                ? []
                : [
                    StartedThread.make({
                      thread,
                      state: threadState(ends.get(thread.id), waiting.has(thread.id)),
                      askedWith: row.asked_with,
                      startedAt: row.started_at,
                    }),
                  ]
            })

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

            return [...threadItems, ...reviews].toSorted((a, b) =>
              DateTime.Order(a.startedAt, b.startedAt),
            )
          }),
        agentReviewStartedAt: ({ owner, repo, number }) =>
          sql`
            SELECT MAX(started_at) AS startedAt FROM started_agent_review
            WHERE owner = ${owner} AND repo = ${repo} AND number = ${number}
          `.pipe(
            Effect.flatMap(decodeStartedAt),
            Effect.map(([found]) => found?.startedAt ?? null),
            Effect.mapError(storageFailure),
          ),
      })
    }),
  )
}

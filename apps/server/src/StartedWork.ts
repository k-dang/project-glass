import {
  Agent,
  AgentError,
  type AgentReviewFailure,
  AgentOutcome,
  type AgentReviewState,
  AgentReviewOutcome,
  finishedReview,
  PullRequestRef,
  type WorkOutcome,
  TurnEnd,
  type TurnEnding,
  WorkUpdate,
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
import { SqlClient } from "effect/sql"
import { AgentReviews } from "./AgentReviews"
import { Agents } from "./Agents"
import { Transcripts } from "./Transcripts"

const StartedState = Schema.Literals(["running", "waiting", "finished", "failed"]).annotate({
  description:
    "running: still working. waiting: waits for the user to answer a Question or Permission request. finished: done, or stopped by the user. failed: ended in an error, or Glass quit while it worked.",
})

type StartedState = typeof StartedState.Type

const startedFields = {
  state: StartedState,
  askedWith: Schema.NullOr(Schema.String).annotate({
    description: "The user's message in this conversation that asked for it, when known.",
  }),
  startedAt: Schema.DateTimeUtcFromString,
}

const StartedAgent = Schema.TaggedStruct("Agent", { agent: Agent, ...startedFields })

const StartedAgentReview = Schema.TaggedStruct("AgentReview", {
  pullRequest: PullRequestRef,
  ...startedFields,
})

export const StartedItem = Schema.Union([StartedAgent, StartedAgentReview])

const workUpdateFields = {
  work_update_outcome_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  workUpdate: Schema.NullOr(Schema.fromJsonString(WorkUpdate)),
}

const AgentRow = Schema.Struct({
  agent_id: Schema.String,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...workUpdateFields,
})

type AgentRow = typeof AgentRow.Type

const ReviewRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...workUpdateFields,
})

type ReviewRow = typeof ReviewRow.Type

const decodeAgentRows = Schema.decodeUnknownEffect(Schema.Array(AgentRow))

const decodeReviewRows = Schema.decodeUnknownEffect(Schema.Array(ReviewRow))

const pullRequestOf = ({ owner, repo, number }: ReviewRow) =>
  new PullRequestRef({ owner, repo, number })

interface ConversationIds {
  readonly conversationId: string
  readonly sessionId: string
}

export interface PendingOutcome {
  readonly work: WorkOutcome
  readonly at: DateTime.Utc
}

const endingReason = (ending: TurnEnding) =>
  Match.value(ending).pipe(
    Match.tagsExhaustive({
      Done: () => null,
      Stopped: () => null,
      Failed: ({ reason }) => reason,
      CutOff: () => "Glass lost the Agent while it worked.",
      Interrupted: () => "Glass quit while it worked.",
    }),
  )

const ifNew = (
  row: AgentRow | ReviewRow,
  at: DateTime.Utc,
  work: WorkOutcome,
): ReadonlyArray<PendingOutcome> =>
  DateTime.isGreaterThanOrEqualTo(at, row.started_at) &&
  (row.work_update_outcome_at === null || DateTime.isGreaterThan(at, row.work_update_outcome_at))
    ? [{ work, at }]
    : []

const storageFailure = () =>
  new AgentError({ message: "Couldn't read or save what the Global conversation started." })

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

const agentState = (ended: TurnEnd | undefined, waiting: boolean): StartedState => {
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
    readonly linkAgent: (
      caller: ConversationIds,
      agentId: string,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, AgentError>
    readonly startedAgentReview: (
      caller: ConversationIds,
      pullRequest: PullRequestRef,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, AgentError>
    readonly list: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<typeof StartedItem.Type>, AgentError | AgentReviewFailure>
    readonly pendingOutcomes: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<PendingOutcome>, AgentError | AgentReviewFailure>
    /** Links pending outcomes to their saved Work update before delivery. */
    readonly recordWorkUpdate: (
      conversationId: string,
      turnId: string,
      outcomes: ReadonlyArray<PendingOutcome>,
    ) => Effect.Effect<void, AgentError>
    readonly reconcileWorkUpdates: (
      conversationId: string,
    ) => Effect.Effect<void, AgentError | AgentReviewFailure>
    readonly changes: (conversationId: string) => Stream.Stream<void>
  }
>()("@glass/server/StartedWork") {
  static readonly layer = Layer.effect(
    StartedWork,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const agents = yield* Agents
      const agentReviews = yield* AgentReviews
      const transcripts = yield* Transcripts
      const recorded = yield* SubscriptionRef.make(0)

      const rows = (conversationId: string) =>
        Effect.all(
          {
            agentRows: sql`
              SELECT c.agent_id, c.asked_with, c.started_at, c.work_update_outcome_at,
                t.context AS workUpdate
              FROM conversation_agent c LEFT JOIN agent_turn t ON t.id = c.work_update_turn_id
              WHERE c.conversation_id = ${conversationId}
            `.pipe(Effect.flatMap(decodeAgentRows)),
            reviewRows: sql`
              SELECT c.owner, c.repo, c.number, c.asked_with, c.started_at, c.work_update_outcome_at,
                t.context AS workUpdate
              FROM conversation_agent_review c LEFT JOIN agent_turn t ON t.id = c.work_update_turn_id
              WHERE c.conversation_id = ${conversationId}
            `.pipe(Effect.flatMap(decodeReviewRows)),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(storageFailure))

      const agentsOf = (agentRows: ReadonlyArray<AgentRow>) =>
        Effect.gen(function* () {
          const [listed, ends, waiting] = yield* Effect.all(
            [
              agents.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
              transcripts.lastEnds(agentRows.map(({ agent_id }) => agent_id)),
              transcripts.waitingNow,
            ],
            { concurrency: "unbounded" },
          )

          const byId = new Map(listed.map((agent) => [agent.id, agent]))

          const started = agentRows.flatMap((row) => {
            const agent = byId.get(row.agent_id)

            return agent === undefined ? [] : [{ row, agent }]
          })

          return { started, ends, waiting }
        })

      const reviewNow = (row: ReviewRow) =>
        agentReviews.watch(pullRequestOf(row)).pipe(Stream.runHead, Effect.map(Option.getOrThrow))

      const changedRows = SubscriptionRef.update(recorded, (count) => count + 1)

      return StartedWork.of({
        linkAgent: ({ conversationId, sessionId }, agentId, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)

            yield* sql`
              INSERT INTO conversation_agent (conversation_id, agent_id, asked_with, started_at)
              VALUES (${conversationId}, ${agentId}, ${askedWith}, ${startedAt})
              ON CONFLICT DO NOTHING
            `.pipe(saved("a started Agent"))
            yield* changedRows
          }),
        startedAgentReview: ({ conversationId, sessionId }, { owner, repo, number }, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)

            yield* sql`
              INSERT INTO conversation_agent_review
                (conversation_id, owner, repo, number, asked_with, started_at)
              VALUES (${conversationId}, ${owner}, ${repo}, ${number}, ${askedWith}, ${startedAt})
              ON CONFLICT DO UPDATE
                SET asked_with = excluded.asked_with, started_at = excluded.started_at,
                  work_update_outcome_at = NULL, work_update_turn_id = NULL
            `.pipe(saved("a started Agent review"))
            yield* changedRows
          }),
        list: (conversationId) =>
          Effect.gen(function* () {
            const { agentRows, reviewRows } = yield* rows(conversationId)
            const { started, ends, waiting } = yield* agentsOf(agentRows)

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

            const agentItems = started.map(({ row, agent }) =>
              StartedAgent.make({
                agent,
                state: agentState(ends.get(agent.id), waiting.has(agent.id)),
                askedWith: row.asked_with,
                startedAt: row.started_at,
              }),
            )

            return [...agentItems, ...reviews].toSorted((a, b) =>
              DateTime.Order(a.startedAt, b.startedAt),
            )
          }),
        pendingOutcomes: (conversationId) =>
          Effect.gen(function* () {
            const { agentRows, reviewRows } = yield* rows(conversationId)
            const { started, ends, waiting } = yield* agentsOf(agentRows)

            const fromAgents = started.flatMap(({ row, agent }): ReadonlyArray<PendingOutcome> => {
              const subject = { agentId: agent.id, name: agent.name, askedWith: row.asked_with }
              const requests = waiting.get(agent.id)

              if (requests !== undefined) {
                const latest = Arr.max(
                  Arr.map(requests, ({ since }) => since),
                  DateTime.Order,
                )

                return ifNew(
                  row,
                  latest,
                  AgentOutcome.make({ ...subject, outcome: "waiting", reason: null }),
                )
              }

              const ended = ends.get(agent.id)

              if (ended === undefined || Predicate.isTagged(ended.ending, "Stopped")) return []

              return ifNew(
                row,
                ended.at,
                AgentOutcome.make({
                  ...subject,
                  outcome: endingState(ended.ending) === "failed" ? "failed" : "finished",
                  reason: endingReason(ended.ending),
                }),
              )
            })

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

            return [...fromAgents, ...fromReviews.flat()]
          }),
        recordWorkUpdate: (conversationId, turnId, outcomes) =>
          Effect.forEach(
            outcomes,
            ({ work, at }) => {
              const outcomeAt = DateTime.formatIso(at)

              return Match.value(work).pipe(
                Match.tagsExhaustive({
                  Agent: ({ agentId }) =>
                    sql`
                      UPDATE conversation_agent SET work_update_outcome_at = ${outcomeAt}, work_update_turn_id = ${turnId}
                      WHERE conversation_id = ${conversationId} AND agent_id = ${agentId}
                    `.pipe(saved("a Work update's covered outcomes")),
                  AgentReview: ({ pullRequest }) =>
                    sql`
                      UPDATE conversation_agent_review SET work_update_outcome_at = ${outcomeAt}, work_update_turn_id = ${turnId}
                      WHERE conversation_id = ${conversationId} AND owner = ${pullRequest.owner}
                        AND repo = ${pullRequest.repo} AND number = ${pullRequest.number}
                    `.pipe(saved("a Work update's covered outcomes")),
                }),
              )
            },
            { discard: true },
          ),
        reconcileWorkUpdates: Effect.fn("StartedWork.reconcileWorkUpdates")(
          function* (conversationId) {
            const { agentRows, reviewRows } = yield* rows(conversationId)

            for (const row of [...agentRows, ...reviewRows]) {
              const context = row.workUpdate

              if (context === null || row.work_update_outcome_at === null) continue

              if ("agent_id" in row) {
                const matched = context.work.find(
                  (work) => Predicate.isTagged(work, "Agent") && work.agentId === row.agent_id,
                )

                if (matched !== undefined && matched.outcome !== "waiting")
                  yield* agents.markTurnSeen(row.agent_id, row.work_update_outcome_at)
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
                  yield* agentReviews.markIncludedInWorkUpdate(pr, row.work_update_outcome_at)
              }
            }
          },
        ),
        changes: (conversationId) =>
          SubscriptionRef.changes(recorded).pipe(
            Stream.switchMap(() =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const ended = yield* transcripts.subscribeEnded
                  const { agentRows, reviewRows } = yield* rows(conversationId)
                  const agentIds = agentRows.map(({ agent_id }) => agent_id)

                  return Stream.mergeAll(
                    [
                      ended.pipe(Stream.filter((agentId) => agentIds.includes(agentId))),
                      transcripts.waiting.pipe(
                        Stream.map((waiting) => agentIds.map((agentId) => waiting.get(agentId))),
                        Stream.changesWith(Arr.makeEquivalence((a, b) => a === b)),
                      ),
                      ...reviewRows.map((row) =>
                        agentReviews
                          .watch(pullRequestOf(row))
                          .pipe(Stream.catch(() => Stream.empty)),
                      ),
                    ].map((changed: Stream.Stream<unknown>) => Stream.as(changed, undefined)),
                    { concurrency: "unbounded" },
                  )
                }).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning(
                      "Couldn't read what the Global conversation started",
                      cause,
                    ).pipe(Effect.as(Stream.empty)),
                  ),
                ),
              ),
            ),
          ),
      })
    }),
  )
}

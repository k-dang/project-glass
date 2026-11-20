import {
  Conversation,
  ConversationError,
  type AgentReviewFailure,
  ConversationOutcome,
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
import { Conversations } from "./Conversations"
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

const StartedConversation = Schema.TaggedStruct("Conversation", {
  conversation: Conversation,
  ...startedFields,
})

const StartedAgentReview = Schema.TaggedStruct("AgentReview", {
  pullRequest: PullRequestRef,
  ...startedFields,
})

export const StartedItem = Schema.Union([StartedConversation, StartedAgentReview])

const startedWorkUpdateFields = {
  started_work_update_outcome_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  startedWorkUpdate: Schema.NullOr(Schema.fromJsonString(StartedWorkUpdate)),
}

const ConversationRow = Schema.Struct({
  conversation_id: Schema.String,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...startedWorkUpdateFields,
})

type ConversationRow = typeof ConversationRow.Type

const ReviewRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
  ...startedWorkUpdateFields,
})

type ReviewRow = typeof ReviewRow.Type

const decodeConversationRows = Schema.decodeUnknownEffect(Schema.Array(ConversationRow))

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
      CutOff: () => "Glass lost the agent while it worked.",
      Interrupted: () => "Glass quit while it worked.",
    }),
  )

const ifNew = (
  row: ConversationRow | ReviewRow,
  at: DateTime.Utc,
  work: WorkOutcome,
): ReadonlyArray<PendingOutcome> =>
  DateTime.isGreaterThanOrEqualTo(at, row.started_at) &&
  (row.started_work_update_outcome_at === null ||
    DateTime.isGreaterThan(at, row.started_work_update_outcome_at))
    ? [{ work, at }]
    : []

const storageFailure = () =>
  new ConversationError({ message: "Couldn't read or save what a conversation started." })

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

const conversationState = (ended: TurnEnd | undefined, waiting: boolean): StartedState => {
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
    readonly linkConversation: (
      starter: Starter,
      conversationId: string,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, ConversationError>
    readonly startedAgentReview: (
      starter: Starter,
      pullRequest: PullRequestRef,
      actedAt: DateTime.Utc,
    ) => Effect.Effect<void, ConversationError>
    readonly list: (
      startedBy: string,
    ) => Effect.Effect<
      ReadonlyArray<typeof StartedItem.Type>,
      ConversationError | AgentReviewFailure
    >
    readonly pendingOutcomes: (
      startedBy: string,
    ) => Effect.Effect<ReadonlyArray<PendingOutcome>, ConversationError | AgentReviewFailure>
    readonly recordStartedWorkUpdate: (
      startedBy: string,
      turnId: string,
      outcomes: ReadonlyArray<PendingOutcome>,
    ) => Effect.Effect<void, ConversationError>
    readonly reconcileStartedWorkUpdates: (
      startedBy: string,
    ) => Effect.Effect<void, ConversationError | AgentReviewFailure>
    readonly starters: Effect.Effect<ReadonlyArray<string>, ConversationError>
    readonly changes: Stream.Stream<void>
  }
>()("@glass/server/StartedWork") {
  static readonly layer = Layer.effect(
    StartedWork,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const conversations = yield* Conversations
      const agentReviews = yield* AgentReviews
      const transcripts = yield* Transcripts
      const recorded = yield* SubscriptionRef.make(0)

      const rowsMatching = (matching: Statement.Fragment) =>
        Effect.all(
          {
            conversationRows: sql`
              SELECT c.conversation_id, c.asked_with, c.started_at, c.started_work_update_outcome_at,
                t.context AS startedWorkUpdate
              FROM started_conversation c LEFT JOIN conversation_turn t ON t.id = c.started_work_update_turn_id
              WHERE ${matching}
            `.pipe(Effect.flatMap(decodeConversationRows)),
            reviewRows: sql`
              SELECT c.owner, c.repo, c.number, c.asked_with, c.started_at, c.started_work_update_outcome_at,
                t.context AS startedWorkUpdate
              FROM started_agent_review c LEFT JOIN conversation_turn t ON t.id = c.started_work_update_turn_id
              WHERE ${matching}
            `.pipe(Effect.flatMap(decodeReviewRows)),
          },
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError(storageFailure))

      const rowsOf = (startedBy: string) => rowsMatching(sql`c.started_by = ${startedBy}`)

      const allRows = rowsMatching(sql.and([]))

      const conversationsOf = (conversationRows: ReadonlyArray<ConversationRow>) =>
        Effect.gen(function* () {
          const [listed, ends, waiting] = yield* Effect.all(
            [
              conversations.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
              transcripts.lastEnds(conversationRows.map(({ conversation_id }) => conversation_id)),
              transcripts.waitingNow,
            ],
            { concurrency: "unbounded" },
          )

          const byId = new Map(listed.map((conversation) => [conversation.id, conversation]))

          const started = conversationRows.flatMap((row) => {
            const conversation = byId.get(row.conversation_id)

            return conversation === undefined ? [] : [{ row, conversation }]
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
              const { conversationRows, reviewRows } = yield* allRows

              const conversationIds = conversationRows.map(({ conversation_id }) => conversation_id)

              return Stream.mergeAll(
                [
                  ended.pipe(
                    Stream.filter((conversationId) => conversationIds.includes(conversationId)),
                  ),
                  transcripts.waiting.pipe(
                    Stream.map((waiting) =>
                      conversationIds.map((conversationId) => waiting.get(conversationId)),
                    ),
                    Stream.changesWith(Arr.makeEquivalence((a, b) => a === b)),
                  ),
                  ...reviewRows.map((row) =>
                    agentReviews.watch(pullRequestOf(row)).pipe(Stream.catch(() => Stream.empty)),
                  ),
                ].map((changed: Stream.Stream<unknown>) => Stream.as(changed, undefined)),
                { concurrency: "unbounded" },
              )
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't read what a conversation started", cause).pipe(
                  Effect.as(Stream.empty),
                ),
              ),
            ),
          ),
        ),
      )

      return StartedWork.of({
        linkConversation: ({ startedBy, sessionId }, conversationId, actedAt) =>
          Effect.gen(function* () {
            const askedWith = yield* transcripts.runningMessage(sessionId)
            const startedAt = DateTime.formatIso(actedAt)

            yield* sql`
              INSERT INTO started_conversation (started_by, conversation_id, asked_with, started_at)
              VALUES (${startedBy}, ${conversationId}, ${askedWith}, ${startedAt})
              ON CONFLICT DO NOTHING
            `.pipe(saved("a started Conversation"))
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
            const { conversationRows, reviewRows } = yield* rowsOf(startedBy)
            const { started, ends, waiting } = yield* conversationsOf(conversationRows)

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

            const conversationItems = started.map(({ row, conversation }) =>
              StartedConversation.make({
                conversation,
                state: conversationState(ends.get(conversation.id), waiting.has(conversation.id)),
                askedWith: row.asked_with,
                startedAt: row.started_at,
              }),
            )

            return [...conversationItems, ...reviews].toSorted((a, b) =>
              DateTime.Order(a.startedAt, b.startedAt),
            )
          }),
        pendingOutcomes: (startedBy) =>
          Effect.gen(function* () {
            const { conversationRows, reviewRows } = yield* rowsOf(startedBy)
            const { started, ends, waiting } = yield* conversationsOf(conversationRows)

            const fromConversations = started.flatMap(
              ({ row, conversation }): ReadonlyArray<PendingOutcome> => {
                const subject = {
                  conversationId: conversation.id,
                  name: conversation.name,
                  askedWith: row.asked_with,
                }

                const requests = waiting.get(conversation.id)

                if (requests !== undefined) {
                  const latest = Arr.max(
                    Arr.map(requests, ({ since }) => since),
                    DateTime.Order,
                  )

                  return ifNew(
                    row,
                    latest,
                    ConversationOutcome.make({ ...subject, outcome: "waiting", reason: null }),
                  )
                }

                const ended = ends.get(conversation.id)

                if (ended === undefined || Predicate.isTagged(ended.ending, "Stopped")) return []

                return ifNew(
                  row,
                  ended.at,
                  ConversationOutcome.make({
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

            return [...fromConversations, ...fromReviews.flat()]
          }),
        recordStartedWorkUpdate: (startedBy, turnId, outcomes) =>
          Effect.forEach(
            outcomes,
            ({ work, at }) => {
              const outcomeAt = DateTime.formatIso(at)

              return Match.value(work).pipe(
                Match.tagsExhaustive({
                  Conversation: ({ conversationId }) =>
                    sql`
                      UPDATE started_conversation SET started_work_update_outcome_at = ${outcomeAt}, started_work_update_turn_id = ${turnId}
                      WHERE started_by = ${startedBy} AND conversation_id = ${conversationId}
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
            const { conversationRows, reviewRows } = yield* rowsOf(startedBy)

            for (const row of [...conversationRows, ...reviewRows]) {
              const context = row.startedWorkUpdate

              if (context === null || row.started_work_update_outcome_at === null) continue

              if ("conversation_id" in row) {
                const matched = context.work.find(
                  (work) =>
                    Predicate.isTagged(work, "Conversation") &&
                    work.conversationId === row.conversation_id,
                )

                if (matched !== undefined && matched.outcome !== "waiting")
                  yield* conversations.markTurnSeen(
                    row.conversation_id,
                    row.started_work_update_outcome_at,
                  )
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
          SELECT started_by FROM started_conversation
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

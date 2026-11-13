import {
  Agent,
  AgentError,
  type AgentReviewFailure,
  type AgentReviewState,
  finishedReview,
  PullRequestRef,
  type Transcript,
  type TurnEnding,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Match, Option, Schema, Stream } from "effect"
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

const AgentRow = Schema.Struct({
  agent_id: Schema.String,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
})

const ReviewRow = Schema.Struct({
  owner: Schema.String,
  repo: Schema.String,
  number: Schema.Int,
  asked_with: Schema.NullOr(Schema.String),
  started_at: Schema.DateTimeUtcFromString,
})

const decodeAgentRows = Schema.decodeUnknownEffect(Schema.Array(AgentRow))

const decodeReviewRows = Schema.decodeUnknownEffect(Schema.Array(ReviewRow))

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

const agentState = ({ turns }: Transcript, waiting: boolean): StartedState => {
  if (waiting) return "waiting"

  const last = turns.at(-1)

  if (last?.ended == null) return "running"

  return endingState(last.ended.ending)
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
    readonly linkAgent: (conversationId: string, agentId: string) => Effect.Effect<void, AgentError>
    readonly startedAgentReview: (
      conversationId: string,
      pullRequest: PullRequestRef,
    ) => Effect.Effect<void, AgentError>
    readonly list: (
      conversationId: string,
    ) => Effect.Effect<ReadonlyArray<typeof StartedItem.Type>, AgentError | AgentReviewFailure>
  }
>()("@glass/server/StartedWork") {
  static readonly layer = Layer.effect(
    StartedWork,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const agents = yield* Agents
      const agentReviews = yield* AgentReviews
      const transcripts = yield* Transcripts

      const asked = (conversationId: string) =>
        Effect.all({
          askedWith: transcripts.runningMessage(conversationId),
          startedAt: DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        })

      return StartedWork.of({
        linkAgent: (conversationId, agentId) =>
          Effect.gen(function* () {
            const { askedWith, startedAt } = yield* asked(conversationId)

            yield* sql`
              INSERT INTO conversation_agent (conversation_id, agent_id, asked_with, started_at)
              VALUES (${conversationId}, ${agentId}, ${askedWith}, ${startedAt})
              ON CONFLICT DO NOTHING
            `.pipe(saved("a started Agent"))
          }),
        startedAgentReview: (conversationId, { owner, repo, number }) =>
          Effect.gen(function* () {
            const { askedWith, startedAt } = yield* asked(conversationId)

            yield* sql`
              INSERT INTO conversation_agent_review
                (conversation_id, owner, repo, number, asked_with, started_at)
              VALUES (${conversationId}, ${owner}, ${repo}, ${number}, ${askedWith}, ${startedAt})
              ON CONFLICT DO UPDATE
                SET asked_with = excluded.asked_with, started_at = excluded.started_at
            `.pipe(saved("a started Agent review"))
          }),
        list: (conversationId) =>
          Effect.gen(function* () {
            const { agentRows, reviewRows, listed } = yield* Effect.all(
              {
                agentRows: sql`
                  SELECT agent_id, asked_with, started_at FROM conversation_agent
                  WHERE conversation_id = ${conversationId}
                `.pipe(Effect.flatMap(decodeAgentRows), Effect.mapError(storageFailure)),
                reviewRows: sql`
                  SELECT owner, repo, number, asked_with, started_at FROM conversation_agent_review
                  WHERE conversation_id = ${conversationId}
                `.pipe(Effect.flatMap(decodeReviewRows), Effect.mapError(storageFailure)),
                listed: agents.watch().pipe(Stream.runHead, Effect.map(Option.getOrThrow)),
              },
              { concurrency: "unbounded" },
            )

            const byId = new Map(listed.map((agent) => [agent.id, agent]))

            const startedAgents = Effect.forEach(
              agentRows.flatMap((row) => {
                const agent = byId.get(row.agent_id)

                return agent === undefined ? [] : [{ row, agent }]
              }),
              ({ row, agent }) =>
                Effect.all([transcripts.read(agent.id), transcripts.isWaiting(agent.id)]).pipe(
                  Effect.map(([transcript, waiting]) =>
                    StartedAgent.make({
                      agent,
                      state: agentState(transcript, waiting),
                      askedWith: row.asked_with,
                      startedAt: row.started_at,
                    }),
                  ),
                ),
              { concurrency: "unbounded" },
            )

            const startedReviews = Effect.forEach(
              reviewRows,
              (row) => {
                const pullRequest = new PullRequestRef({
                  owner: row.owner,
                  repo: row.repo,
                  number: row.number,
                })

                return agentReviews.watch(pullRequest).pipe(
                  Stream.runHead,
                  Effect.map((state) =>
                    StartedAgentReview.make({
                      pullRequest,
                      state: reviewState(Option.getOrThrow(state)),
                      askedWith: row.asked_with,
                      startedAt: row.started_at,
                    }),
                  ),
                )
              },
              { concurrency: "unbounded" },
            )

            const [started, reviews] = yield* Effect.all([startedAgents, startedReviews], {
              concurrency: "unbounded",
            })

            return [...started, ...reviews].toSorted((a, b) =>
              DateTime.Order(a.startedAt, b.startedAt),
            )
          }),
      })
    }),
  )
}

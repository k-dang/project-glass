import {
  AgentReview,
  AgentReviewFailure,
  type AgentReviewState,
  type PullRequestRef,
  Revision,
  type AgentRunnerIdentity,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/sql"
import { AgentReviewAnswer, agentReviewInstructions, agentReviewPrompt } from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { ServerConfig } from "./ServerConfig"
import { SettingsStore } from "./SettingsStore"

type Job = PullRequestJob<AgentReviewState>

const setJob = (job: Job, status: AgentReviewState["job"]) =>
  SubscriptionRef.update(job.state, ({ review }) => ({ review, job: status }))

const stored = Schema.Array(
  Schema.Struct({
    base: Schema.String,
    head: Schema.String,
    written_at: Schema.DateTimeUtcFromString,
    markdown: Schema.String,
  }),
)

const failure = (
  reason: AgentReviewFailure["reason"],
  message: string,
  runner: AgentRunnerIdentity | null = null,
) => new AgentReviewFailure({ reason, message, runner })

const storageFailure = () =>
  failure("storage", "Couldn't load or save your Agent review. Try again.")

const logStorageFailure = Effect.tapError((cause: unknown) =>
  Effect.logWarning("Couldn't load or save an Agent review", cause),
)

const fromCheckoutRunFailure = ({ reason, message, runner }: CheckoutRunFailure) =>
  failure(reason, message, runner)

export class AgentReviews extends Context.Service<
  AgentReviews,
  {
    readonly start: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly cancel: (pr: PullRequestRef) => Effect.Effect<void, AgentReviewFailure>
    readonly watch: (pr: PullRequestRef) => Stream.Stream<AgentReviewState, AgentReviewFailure>
  }
>()("@glass/server/AgentReviews") {
  static readonly layer = Layer.effect(
    AgentReviews,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const checkoutRuns = yield* CheckoutRuns
      const github = yield* GitHubClient
      const config = yield* ServerConfig
      const settings = yield* SettingsStore

      const load = Effect.fnUntraced(function* (pr: PullRequestRef) {
        const rows =
          yield* sql`SELECT base, head, written_at, markdown FROM agent_reviews WHERE owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(stored)),
            logStorageFailure,
            Effect.mapError(storageFailure),
          )

        const row = rows[0]

        const review =
          row === undefined
            ? null
            : AgentReview.make({
                revision: new Revision({ base: row.base, head: row.head }),
                writtenAt: row.written_at,
                markdown: row.markdown,
              })

        return { review, job: { status: "idle" } } satisfies AgentReviewState
      })

      const jobs = yield* pullRequestJobs<AgentReviewState, AgentReviewFailure>({
        load,
        inProgress: ({ job }) => job.status === "reviewing",
        idle: ({ review }) => ({ review, job: { status: "idle" } }),
      })

      const save = (job: Job, pr: PullRequestRef, review: AgentReview) =>
        jobs.commit(
          job,
          sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown)
            VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown})
            ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown`.pipe(
            logStorageFailure,
            Effect.mapError(storageFailure),
          ),
          { review, job: { status: "idle" } },
        )

      const work = (job: Job, pr: PullRequestRef, revision: Revision, startedAt: number) =>
        Effect.gen(function* () {
          const runner = yield* checkoutRuns.select().pipe(Effect.mapError(fromCheckoutRunFailure))

          const { reviewPrompt } = yield* settings
            .read()
            .pipe(Effect.mapError((error) => failure("not-ready", error.message)))

          yield* setJob(job, { status: "reviewing", startedAt, runner: runner.identity })

          const answer = yield* runner
            .run({
              pr,
              revision,
              subject: "Agent review",
              timeout: config.agentReviewTimeoutMs,
              read: github.reviewInput,
              task: (material) =>
                Effect.succeed({
                  instructions: agentReviewInstructions(reviewPrompt),
                  prompt: agentReviewPrompt(material),
                  answer: AgentReviewAnswer,
                }),
            })
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          return AgentReview.make({
            revision,
            writtenAt: yield* DateTime.now,
            markdown: answer.markdown,
          })
        }).pipe(
          Effect.scoped,
          Effect.flatMap((review) => save(job, pr, review)),
          jobs.settle(
            job,
            ({ review, job: current }, error: Option.Option<AgentReviewFailure>) => ({
              review,
              job: {
                status: "failed",
                reason: Option.getOrElse(error, () =>
                  failure(
                    "runner",
                    "The agent runner stopped unexpectedly. Check its installation and try again.",
                    current.status === "reviewing" ? current.runner : null,
                  ),
                ),
              },
            }),
          ),
        )

      const start = Effect.fn("AgentReviews.start")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
            yield* setJob(job, { status: "reviewing", startedAt, runner: null })
            yield* replace(work(job, pr, revision, startedAt))
          }),
        )
      })

      const cancel = Effect.fn("AgentReviews.cancel")(function* (pr: PullRequestRef) {
        yield* jobs.stop(yield* jobs.jobFor(pr))
      })

      return AgentReviews.of({
        start,
        cancel,
        watch: jobs.watch,
      })
    }),
  )
}

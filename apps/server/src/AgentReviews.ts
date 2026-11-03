import {
  AgentReview,
  AgentReviewFailure,
  type AgentReviewState,
  agentModelOf,
  type ChangedFile,
  type DiffSide,
  FollowedRepository,
  type PullRequestRef,
  Revision,
  type AgentRunnerIdentity,
  runnerIdentity,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Equal,
  FileSystem,
  Layer,
  Option,
  Predicate,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { Agents } from "./Agents"
import { AgentReviewAnswer, agentReviewInstructions, agentReviewPrompt } from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { followUpInstructions } from "./followUpInstructions"
import { GitHubClient } from "./github/GitHubClient"
import { patchLineNumbers } from "./github/patchLines"
import { pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { ServerConfig } from "./ServerConfig"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"

type Job = PullRequestJob<AgentReviewState>

const setJob = (job: Job, status: AgentReviewState["job"]) =>
  SubscriptionRef.update(job.state, ({ review }) => ({ review, job: status }))

const stored = Schema.Array(
  Schema.Struct({
    base: Schema.String,
    head: Schema.String,
    written_at: Schema.DateTimeUtcFromString,
    markdown: Schema.String,
    agent_id: Schema.NullOr(Schema.String),
  }),
)

/** Every line of the diff on one side, by path: where a Suggested draft may go. */
const diffLinesOn = (files: ReadonlyArray<ChangedFile>, side: DiffSide) =>
  Object.fromEntries(
    files.flatMap(({ path, patch }) =>
      Predicate.isTagged(patch, "TextPatch") ? [[path, patchLineNumbers(patch.hunks, side)]] : [],
    ),
  )

/** The runner of the work in progress, for a failure that names none. */
const runnerOf = (job: AgentReviewState["job"]) => ("runner" in job ? job.runner : null)

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

const stoppedRunner = (runner: AgentRunnerIdentity | null) =>
  failure(
    "runner",
    "The agent runner stopped unexpectedly. Check its installation and try again.",
    runner,
  )

export class AgentReviews extends Context.Service<
  AgentReviews,
  {
    readonly start: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly followUp: (
      pr: PullRequestRef,
      revision: Revision,
      message: string,
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
      const agents = yield* Agents
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.Scope

      const where = (pr: PullRequestRef) =>
        sql`owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`

      const load = Effect.fnUntraced(
        function* (pr: PullRequestRef) {
          const rows =
            yield* sql`SELECT base, head, written_at, markdown, agent_id FROM agent_reviews WHERE ${where(pr)}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(stored)),
            )

          const row = rows[0]

          const review =
            row === undefined
              ? null
              : AgentReview.make({
                  revision: new Revision({ base: row.base, head: row.head }),
                  writtenAt: row.written_at,
                  markdown: row.markdown,
                  agentId: row.agent_id,
                })

          return { review, job: { status: "idle" } } satisfies AgentReviewState
        },
        logStorageFailure,
        Effect.mapError(storageFailure),
      )

      const jobs = yield* pullRequestJobs<AgentReviewState, AgentReviewFailure>({
        load,
        inProgress: ({ job }) => job.status === "reviewing" || job.status === "following-up",
        idle: ({ review }) => ({ review, job: { status: "idle" } }),
      })

      const removeAgent = (agentId: string | null) =>
        agentId === null
          ? Effect.void
          : agents.remove(agentId).pipe(
              Effect.catchTag("AgentNotFound", () => Effect.void),
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't remove an Agent review's Agent", cause),
              ),
            )

      // Writing the review again removes the Agent of the one it replaces, after showing the new
      // review: removing deletes a whole checkout.
      const save = (job: Job, pr: PullRequestRef, review: AgentReview) =>
        Effect.gen(function* () {
          const replaced = (yield* SubscriptionRef.get(job.state)).review?.agentId ?? null

          yield* jobs.commit(
            job,
            sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, agent_id)
              VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown}, NULL)
              ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown, agent_id = NULL`.pipe(
              logStorageFailure,
              Effect.mapError(storageFailure),
            ),
            { review, job: { status: "idle" } },
          )

          yield* removeAgent(replaced).pipe(Effect.forkIn(scope))
        })

      const reviewPrompt = settings.read().pipe(
        Effect.map((saved) => saved.reviewPrompt),
        Effect.mapError((error) => failure("not-ready", error.message)),
      )

      const work = (job: Job, pr: PullRequestRef, revision: Revision, startedAt: number) =>
        Effect.gen(function* () {
          const runner = yield* checkoutRuns.select().pipe(Effect.mapError(fromCheckoutRunFailure))
          const prompt = yield* reviewPrompt

          yield* setJob(job, { status: "reviewing", startedAt, runner: runner.identity })

          const { answer } = yield* runner
            .run({
              pr,
              revision,
              subject: "Agent review",
              timeout: config.agentReviewTimeoutMs,
              read: github.reviewInput,
              task: (material) =>
                Effect.succeed({
                  instructions: agentReviewInstructions(prompt),
                  prompt: agentReviewPrompt(material),
                  answer: AgentReviewAnswer,
                }),
            })
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          return AgentReview.make({
            revision,
            writtenAt: yield* DateTime.now,
            markdown: answer.markdown,
            agentId: null,
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
                reason: Option.getOrElse(error, () => stoppedRunner(runnerOf(current))),
              },
            }),
          ),
        )

      /**
       * Starts the review's Agent in a lasting checkout of its Revision, with the first Follow-up
       * as its first Turn. The checkout is the Agent's once it exists.
       */
      const startAgent = (
        job: Job,
        pr: PullRequestRef,
        review: AgentReview,
        message: string,
        {
          runner,
          model,
          reviewPrompt: prompt,
        }: { runner: AgentRunnerIdentity; model: string; reviewPrompt: string },
      ) =>
        // Only copying the checkout can be cancelled: an Agent that exists is saved on its review.
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const folder = join(config.dataDirectory, "agent-review-checkouts", randomUUID())

            const removeFolder = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.onError(() =>
                  fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
                ),
              )

            const input = yield* restore(
              checkoutRuns
                .copy({
                  pr,
                  revision: review.revision,
                  subject: "Follow-up",
                  folder,
                  read: github.reviewInput,
                })
                .pipe(Effect.mapError(fromCheckoutRunFailure)),
            ).pipe(removeFolder)

            const agent = yield* agents
              .createForReview({
                name: `Follow-ups on ${pr.owner}/${pr.repo}#${pr.number}`,
                repository: new FollowedRepository({ owner: pr.owner, repo: pr.repo }),
                // It works on no branch, only on the Revision.
                baseBranch: review.revision.base,
                engine: runner.engine,
                model,
                folder,
                review: {
                  instructions: followUpInstructions(prompt, input, review),
                  diffLines: {
                    old: diffLinesOn(input.files, "old"),
                    new: diffLinesOn(input.files, "new"),
                  },
                },
                message,
              })
              .pipe(
                Effect.mapError(({ message: reason }) => failure("runner", reason, runner)),
                removeFolder,
              )

            yield* jobs
              .commit(
                job,
                sql`UPDATE agent_reviews SET agent_id = ${agent.id} WHERE ${where(pr)}`.pipe(
                  logStorageFailure,
                  Effect.mapError(storageFailure),
                ),
                { review: { ...review, agentId: agent.id }, job: { status: "idle" } },
              )
              .pipe(Effect.onError(() => removeAgent(agent.id)))
          }),
        ).pipe(
          jobs.settle(job, (state, error: Option.Option<AgentReviewFailure>) => ({
            review: state.review,
            job: {
              status: "follow-up-failed",
              message,
              reason: Option.getOrElse(error, () => stoppedRunner(runner)),
            },
          })),
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

      const followUp = Effect.fn("AgentReviews.followUp")(function* (
        pr: PullRequestRef,
        revision: Revision,
        message: string,
      ) {
        const job = yield* jobs.jobFor(pr)

        const agentId = yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            const { review, job: current } = yield* SubscriptionRef.get(job.state)

            // Writing the review again replaces its Agent, so it takes no Follow-up meanwhile.
            if (current.status === "reviewing")
              return yield* failure("not-ready", "Wait for the Agent review to finish.")

            if (current.status === "following-up")
              return yield* failure("not-ready", "Wait for the agent to start.")

            if (review === null || !Equal.equals(review.revision, revision))
              return yield* failure(
                "stale-revision",
                "This Agent review was written for another Revision. Review again to follow up.",
              )

            if (review.agentId !== null) return review.agentId

            const saved = yield* settings
              .read()
              .pipe(Effect.mapError((error) => failure("not-ready", error.message)))

            const engineSettings = engineSettingsOf(saved, "agentReviews")
            const runner = runnerIdentity(engineSettings)

            const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
            yield* setJob(job, { status: "following-up", message, startedAt, runner })
            yield* replace(
              startAgent(job, pr, review, message, {
                runner,
                model: agentModelOf(engineSettings),
                reviewPrompt: saved.reviewPrompt,
              }),
            )

            return null
          }),
        )

        if (agentId === null) return

        yield* agents
          .send(agentId, { message, images: [] })
          .pipe(
            Effect.mapError((error) =>
              Predicate.isTagged(error, "RequestWaiting")
                ? failure("not-ready", "Answer the agent's request first.")
                : failure(
                    "runner",
                    Predicate.isTagged(error, "AgentNotFound")
                      ? "This Agent review's Agent is gone. Review again to follow up."
                      : error.message,
                  ),
            ),
          )
      })

      const cancel = Effect.fn("AgentReviews.cancel")(function* (pr: PullRequestRef) {
        yield* jobs.stop(yield* jobs.jobFor(pr))
      })

      return AgentReviews.of({
        start,
        followUp,
        cancel,
        watch: jobs.watch,
      })
    }),
  )
}

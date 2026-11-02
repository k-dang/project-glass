import {
  AgentReview,
  AgentReviewFailure,
  type AgentReviewState,
  type ChangedFile,
  type FollowUp,
  type PullRequestRef,
  Revision,
  type AgentRunnerIdentity,
  SuggestedDraft,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Equal,
  Layer,
  Option,
  Predicate,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { AgentReviewAnswer, agentReviewInstructions, agentReviewPrompt } from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { FollowUpAnswer, followUpInstructions, followUpPrompt } from "./followUpPrompt"
import { GitHubClient } from "./github/GitHubClient"
import { lineInPatch } from "./github/patchLines"
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

const storedFollowUps = Schema.Array(
  Schema.Struct({
    message: Schema.String,
    answer: Schema.String,
    suggested_drafts: Schema.fromJsonString(Schema.Array(SuggestedDraft)),
  }),
)

const encodeSuggestedDrafts = Schema.encodeSync(Schema.fromJsonString(Schema.Array(SuggestedDraft)))

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

const onDiffLine = (files: ReadonlyArray<ChangedFile>, draft: SuggestedDraft) => {
  const file = files.find((candidate) => candidate.path === draft.path)

  return (
    file !== undefined &&
    Predicate.isTagged(file.patch, "TextPatch") &&
    lineInPatch(file.patch.hunks, draft.side, draft.line) !== null
  )
}

/** A comment the agent placed off the diff can't be a Draft, so its text joins the answer. */
const unplacedText = (drafts: ReadonlyArray<SuggestedDraft>) =>
  drafts.length === 0
    ? ""
    : [
        "\n\n**Not on a line of the diff, so not a Draft:**",
        ...drafts.map(
          ({ path, line, body }) =>
            `\`${path}\` line ${line}:\n\n${body
              .split("\n")
              .map((text) => `> ${text}`)
              .join("\n")}`,
        ),
      ].join("\n\n")

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

      const where = (pr: PullRequestRef) =>
        sql`owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`

      const load = Effect.fnUntraced(
        function* (pr: PullRequestRef) {
          const rows =
            yield* sql`SELECT base, head, written_at, markdown FROM agent_reviews WHERE ${where(pr)}`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(stored)),
            )

          const row = rows[0]

          if (row === undefined)
            return { review: null, job: { status: "idle" } } satisfies AgentReviewState

          const followUps =
            yield* sql`SELECT message, answer, suggested_drafts FROM agent_review_follow_ups WHERE ${where(pr)} ORDER BY position`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(storedFollowUps)),
            )

          const review = AgentReview.make({
            revision: new Revision({ base: row.base, head: row.head }),
            writtenAt: row.written_at,
            markdown: row.markdown,
            followUps: followUps.map(({ message, answer, suggested_drafts }) => ({
              message,
              answer,
              suggestedDrafts: suggested_drafts,
            })),
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

      const save = (job: Job, pr: PullRequestRef, review: AgentReview) =>
        jobs.commit(
          job,
          Effect.gen(function* () {
            yield* sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown)
              VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown})
              ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown`
            yield* sql`DELETE FROM agent_review_follow_ups WHERE ${where(pr)}`
          }).pipe(sql.withTransaction, logStorageFailure, Effect.mapError(storageFailure)),
          { review, job: { status: "idle" } },
        )

      const saveFollowUp = (
        job: Job,
        pr: PullRequestRef,
        review: AgentReview,
        followUp: FollowUp,
      ) =>
        jobs.commit(
          job,
          sql`INSERT INTO agent_review_follow_ups (owner, repo, number, position, message, answer, suggested_drafts)
            VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.followUps.length}, ${followUp.message}, ${followUp.answer}, ${encodeSuggestedDrafts(followUp.suggestedDrafts)})`.pipe(
            logStorageFailure,
            Effect.mapError(storageFailure),
          ),
          {
            review: { ...review, followUps: [...review.followUps, followUp] },
            job: { status: "idle" },
          },
        )

      const reviewPrompt = settings.read().pipe(
        Effect.map((saved) => saved.reviewPrompt),
        Effect.mapError((error) => failure("not-ready", error.message)),
      )

      const work = (job: Job, pr: PullRequestRef, revision: Revision, startedAt: number) =>
        Effect.gen(function* () {
          const runner = yield* checkoutRuns.select().pipe(Effect.mapError(fromCheckoutRunFailure))
          const prompt = yield* reviewPrompt

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
            followUps: [],
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
                  stoppedRunner(current.status === "reviewing" ? current.runner : null),
                ),
              },
            }),
          ),
        )

      const followUpWork = (
        job: Job,
        pr: PullRequestRef,
        review: AgentReview,
        message: string,
        startedAt: number,
      ) =>
        Effect.gen(function* () {
          const runner = yield* checkoutRuns.select().pipe(Effect.mapError(fromCheckoutRunFailure))
          const prompt = yield* reviewPrompt

          yield* setJob(job, {
            status: "following-up",
            message,
            startedAt,
            runner: runner.identity,
          })

          let files: ReadonlyArray<ChangedFile> = []

          const answer = yield* runner
            .run({
              pr,
              revision: review.revision,
              subject: "answer",
              timeout: config.askTimeoutMs,
              read: github.reviewInput,
              task: (material) => {
                files = material.files

                return Effect.succeed({
                  instructions: followUpInstructions(prompt),
                  prompt: followUpPrompt(material, review.markdown, review.followUps, message),
                  answer: FollowUpAnswer,
                })
              },
            })
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          const placed = answer.suggestedDrafts.filter((draft) => onDiffLine(files, draft))
          const unplaced = answer.suggestedDrafts.filter((draft) => !onDiffLine(files, draft))

          return {
            message,
            answer: answer.markdown + unplacedText(unplaced),
            suggestedDrafts: placed,
          } satisfies FollowUp
        }).pipe(
          Effect.scoped,
          Effect.flatMap((followUp) => saveFollowUp(job, pr, review, followUp)),
          jobs.settle(job, (state, error: Option.Option<AgentReviewFailure>) => ({
            review: state.review,
            job: {
              status: "follow-up-failed",
              message,
              reason: Option.getOrElse(error, () =>
                stoppedRunner(state.job.status === "following-up" ? state.job.runner : null),
              ),
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

        yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            const { review, job: current } = yield* SubscriptionRef.get(job.state)

            if (current.status === "reviewing")
              return yield* failure("not-ready", "Wait for the Agent review to finish.")

            if (review === null || !Equal.equals(review.revision, revision))
              return yield* failure(
                "stale-revision",
                "This Agent review was written for another Revision. Review again to follow up.",
              )

            const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
            yield* setJob(job, { status: "following-up", message, startedAt, runner: null })

            return yield* replace(followUpWork(job, pr, review, message, startedAt))
          }),
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

import {
  AgentReview,
  AgentReviewFailure,
  type AgentReviewState,
  agentModelOf,
  type ChangedFile,
  type DiffSide,
  FollowedRepository,
  Hotspot,
  LowAttentionFile,
  type PullRequestRef,
  Revision,
  type AgentRunnerIdentity,
  runnerIdentity,
} from "@glass/contracts"
import {
  Clock,
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
import {
  AgentReviewAnswer,
  agentReviewInstructions,
  agentReviewPrompt,
  MAX_HOTSPOTS,
} from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { followUpInstructions } from "./followUpInstructions"
import { GitHubClient } from "./github/GitHubClient"
import { patchLineNumbers, rangeInFiles } from "./github/patchLines"
import { type JobState, pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { Deadlines, ServerConfig } from "./ServerConfig"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"

const BACKGROUND_SLOTS = 1

type Status = AgentReviewState["job"]

type Progress = Extract<Status, { status: "reviewing" | "starting-agent" }>

type Failed = Extract<Status, { status: "failed" | "agent-start-failed" }>

type Job = PullRequestJob<AgentReview, Progress, Failed>

const toState = ({ output, run }: JobState<AgentReview, Progress, Failed>): AgentReviewState => {
  if (run.status === "running") return { review: output, job: run.progress }

  if (run.status === "failed") return { review: output, job: run.failure }

  return { review: output, job: { status: run.status } }
}

const HotspotsJson = Schema.fromJsonString(Schema.Array(Hotspot))

const LowAttentionJson = Schema.fromJsonString(Schema.Array(LowAttentionFile))

const stored = Schema.Array(
  Schema.Struct({
    base: Schema.String,
    head: Schema.String,
    written_at: Schema.DateTimeUtcFromString,
    markdown: Schema.String,
    hotspots: HotspotsJson,
    low_attention: LowAttentionJson,
    agent_id: Schema.NullOr(Schema.String),
    done: Schema.BooleanFromBit,
    reported: Schema.BooleanFromBit,
  }),
)

const encodeHotspots = Schema.encodeSync(HotspotsJson)

const encodeLowAttention = Schema.encodeSync(LowAttentionJson)

const fitToDiff = (answer: AgentReviewAnswer, files: ReadonlyArray<ChangedFile>) => {
  const hotspots = answer.hotspots.slice(0, MAX_HOTSPOTS).map((hotspot) => ({
    ...hotspot,
    place: hotspot.place !== null && rangeInFiles(files, hotspot.place) ? hotspot.place : null,
  }))

  const hotspotPaths = new Set(
    hotspots.flatMap(({ place }) => (place === null ? [] : [place.path])),
  )

  const changed = new Set(files.map(({ path }) => path))

  const lowAttention = answer.lowAttention.filter(
    (file) => changed.has(file.path) && !hotspotPaths.has(file.path),
  )

  return { hotspots, lowAttention }
}

const diffLinesOn = (files: ReadonlyArray<ChangedFile>, side: DiffSide) =>
  Object.fromEntries(
    files.flatMap(({ path, patch }) =>
      Predicate.isTagged(patch, "TextPatch") ? [[path, patchLineNumbers(patch.hunks, side)]] : [],
    ),
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
    readonly startInBackground: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly followUp: (
      pr: PullRequestRef,
      revision: Revision,
      message: string,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly cancel: (pr: PullRequestRef) => Effect.Effect<void>
    readonly markDone: (
      pr: PullRequestRef,
      writtenAt: DateTime.Utc,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly markReported: (
      pr: PullRequestRef,
      writtenAt: DateTime.Utc,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly cancelBackground: () => Effect.Effect<void>
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
      const deadlines = yield* Deadlines
      const settings = yield* SettingsStore
      const agents = yield* Agents
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.Scope

      const where = (pr: PullRequestRef) =>
        sql`owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`

      const load = Effect.fnUntraced(
        function* (pr: PullRequestRef) {
          const rows =
            yield* sql`SELECT base, head, written_at, markdown, hotspots, low_attention, agent_id, done, reported FROM agent_reviews WHERE ${where(pr)}`.pipe(
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
                  hotspots: row.hotspots,
                  lowAttention: row.low_attention,
                  agentId: row.agent_id,
                  done: row.done,
                  reported: row.reported,
                })

          return review
        },
        logStorageFailure,
        Effect.mapError(storageFailure),
      )

      const jobs = yield* pullRequestJobs({ load, toState, backgroundSlots: BACKGROUND_SLOTS })

      const removeAgent = (agentId: string | null) =>
        agentId === null
          ? Effect.void
          : agents.remove(agentId).pipe(
              Effect.catchTag("AgentNotFound", () => Effect.void),
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't remove an Agent review's Agent", cause),
              ),
            )

      const save = (job: Job, pr: PullRequestRef, review: AgentReview) =>
        Effect.gen(function* () {
          const replaced = (yield* SubscriptionRef.get(job.state)).output?.agentId ?? null

          yield* jobs.commit(
            job,
            sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, hotspots, low_attention, agent_id, done, reported)
              VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown}, ${encodeHotspots(review.hotspots)}, ${encodeLowAttention(review.lowAttention)}, NULL, 0, 0)
              ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown, hotspots = excluded.hotspots, low_attention = excluded.low_attention, agent_id = NULL, done = 0, reported = 0`.pipe(
              logStorageFailure,
              Effect.mapError(storageFailure),
            ),
            () => review,
          )

          yield* removeAgent(replaced).pipe(Effect.forkIn(scope))
        })

      const reviewPrompt = settings.read().pipe(
        Effect.map((saved) => saved.reviewPrompt),
        Effect.mapError((error) => failure("not-ready", error.message)),
      )

      const started = Clock.currentTimeMillis.pipe(
        Effect.map((startedAt): Progress => ({ status: "reviewing", startedAt, runner: null })),
      )

      const work = (job: Job, pr: PullRequestRef, revision: Revision) =>
        Effect.gen(function* () {
          const runner = yield* checkoutRuns
            .select("agentReviews")
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          const prompt = yield* reviewPrompt

          yield* jobs.progress(job, (progress) => ({ ...progress, runner: runner.identity }))

          const { input, answer } = yield* runner
            .run({
              pr,
              revision,
              subject: "Agent review",
              timeout: deadlines.agentReviewMs,
              read: github.reviewInput,
              task: (material) =>
                Effect.succeed({
                  instructions: agentReviewInstructions(prompt),
                  prompt: agentReviewPrompt(material, revision),
                  answer: AgentReviewAnswer,
                  tools: "shell",
                }),
            })
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          return AgentReview.make({
            revision,
            writtenAt: yield* DateTime.now,
            markdown: answer.markdown,
            ...fitToDiff(answer, input.files),
            agentId: null,
            done: false,
            reported: false,
          })
        }).pipe(
          Effect.scoped,
          Effect.flatMap((review) => save(job, pr, review)),
          jobs.settle(
            job,
            "AgentReview",
            (error: Option.Option<AgentReviewFailure>, { runner }): Failed => ({
              status: "failed",
              reason: Option.getOrElse(error, () => stoppedRunner(runner)),
            }),
          ),
        )

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
                revision: review.revision,
                engine: runner.engine,
                model,
                checkout: folder,
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
                (current) => ({ ...(current ?? review), agentId: agent.id }),
              )
              .pipe(Effect.onError(() => removeAgent(agent.id)))
          }),
        ).pipe(
          jobs.settle(
            job,
            "AgentReview.startAgent",
            (error: Option.Option<AgentReviewFailure>): Failed => ({
              status: "agent-start-failed",
              message,
              reason: Option.getOrElse(error, () => stoppedRunner(runner)),
            }),
          ),
        )

      const start = Effect.fn("AgentReviews.start")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.flatMap(started, (progress) => replace(progress, work(job, pr, revision))),
        )
      })

      const startInBackground = Effect.fn("AgentReviews.startInBackground")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        yield* jobs.startInBackground(pr, started, (job) => work(job, pr, revision))
      })

      const followUp = Effect.fn("AgentReviews.followUp")(function* (
        pr: PullRequestRef,
        revision: Revision,
        message: string,
      ) {
        const job = yield* jobs.jobFor(pr)

        const agentId = yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            const { output: review, run } = yield* SubscriptionRef.get(job.state)

            if (run.status === "running" && run.progress.status === "starting-agent")
              return yield* failure("not-ready", "Wait for the agent to start.")

            if (run.status === "waiting" || run.status === "running")
              return yield* failure("not-ready", "Wait for the Agent review to finish.")

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

            const startedAt = yield* Clock.currentTimeMillis
            yield* replace(
              { status: "starting-agent", message, startedAt, runner },
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

      const mark = (flag: "done" | "reported", name: string) =>
        Effect.fn(name)(function* (pr: PullRequestRef, writtenAt: DateTime.Utc) {
          const job = yield* jobs.jobFor(pr)

          yield* jobs.amend(job, (review) =>
            Effect.gen(function* () {
              if (
                review === null ||
                review[flag] ||
                !DateTime.Equivalence(review.writtenAt, writtenAt)
              )
                return review

              yield* sql`UPDATE agent_reviews SET ${sql(flag)} = 1 WHERE ${where(pr)}`.pipe(
                logStorageFailure,
                Effect.mapError(storageFailure),
              )

              return { ...review, [flag]: true }
            }),
          )
        })

      return AgentReviews.of({
        start,
        startInBackground,
        followUp,
        cancel: jobs.stop,
        markDone: mark("done", "AgentReviews.markDone"),
        markReported: mark("reported", "AgentReviews.markReported"),
        cancelBackground: jobs.stopBackground,
        watch: jobs.watch,
      })
    }),
  )
}

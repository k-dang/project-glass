import {
  AgentReview,
  AgentReviewFailure,
  type AgentReviewState,
  AgentRunnerIdentity,
  applyTranscriptUpdate,
  type ChangedFile,
  type DiffSide,
  emptyTranscript,
  Hotspot,
  LowAttentionFile,
  PullRequestRef,
  Revision,
  runnerIdentity,
  threadModelOf,
  type TourCodeTarget,
  type TurnEnding,
} from "@glass/contracts"
import {
  Clock,
  Context,
  DateTime,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Match,
  Option,
  Predicate,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient, type SqlError } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { ReviewBrief } from "./agentHost/protocol"
import { type AgentReviewAnswer, submittedReviewOf } from "./agentHost/submitReviewTool"
import { agentReviewInstructions, agentReviewPrompt, MAX_HOTSPOTS } from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { patchLineNumbers } from "./github/patchLines"
import { type JobState, pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { Deadlines, ServerConfig } from "./ServerConfig"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"
import { Threads } from "./Threads"

const BACKGROUND_SLOTS = 2

type Status = AgentReviewState["job"]

type Progress = Extract<Status, { status: "reviewing" }>

type Failed = Extract<Status, { status: "failed" }>

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
    thread_id: Schema.NullOr(Schema.String),
    done: Schema.BooleanFromBit,
    included_in_started_work_update: Schema.BooleanFromBit,
  }),
)

const encodeHotspots = Schema.encodeSync(HotspotsJson)

const encodeLowAttention = Schema.encodeSync(LowAttentionJson)

const ReviewDiff = Schema.Struct({
  paths: Schema.Array(Schema.String),
  lines: ReviewBrief.fields.diffLines,
})

type ReviewDiff = typeof ReviewDiff.Type

const RunnerJson = Schema.fromJsonString(AgentRunnerIdentity)

const DiffJson = Schema.fromJsonString(ReviewDiff)

const encodeRunner = Schema.encodeSync(RunnerJson)

const encodeDiff = Schema.encodeSync(DiffJson)

const StoredRuns = Schema.Array(
  Schema.Struct({
    ...PullRequestRef.fields,
    thread_id: Schema.String,
    base: Schema.String,
    head: Schema.String,
    started_at: Schema.Number,
    runner: RunnerJson,
    background: Schema.BooleanFromBit,
    diff: DiffJson,
  }),
)

interface Run {
  readonly pr: PullRequestRef
  readonly threadId: string
  readonly revision: Revision
  readonly startedAt: number
  readonly runner: AgentRunnerIdentity
  readonly background: boolean
  readonly diff: ReviewDiff
}

const diffLinesOn = (files: ReadonlyArray<ChangedFile>, side: DiffSide) =>
  Object.fromEntries(
    files.flatMap(({ path, patch }) =>
      Predicate.isTagged(patch, "TextPatch") ? [[path, patchLineNumbers(patch.hunks, side)]] : [],
    ),
  )

const diffOf = (files: ReadonlyArray<ChangedFile>): ReviewDiff => ({
  paths: files.map(({ path }) => path),
  lines: { old: diffLinesOn(files, "old"), new: diffLinesOn(files, "new") },
})

const inDiff = ({ lines }: ReviewDiff, { path, side, startLine, endLine }: TourCodeTarget) =>
  endLine >= startLine &&
  (lines[side][path] ?? []).filter((line) => line >= startLine && line <= endLine).length ===
    endLine - startLine + 1

const fitToDiff = (answer: AgentReviewAnswer, diff: ReviewDiff) => {
  const hotspots = answer.hotspots.slice(0, MAX_HOTSPOTS).map((hotspot) => ({
    ...hotspot,
    place: hotspot.place !== null && inDiff(diff, hotspot.place) ? hotspot.place : null,
  }))

  const hotspotPaths = new Set(
    hotspots.flatMap(({ place }) => (place === null ? [] : [place.path])),
  )

  const changed = new Set(diff.paths)

  const lowAttention = answer.lowAttention.filter(
    (file) => changed.has(file.path) && !hotspotPaths.has(file.path),
  )

  return { hotspots, lowAttention }
}

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

const unfinished = (ending: TurnEnding, runner: AgentRunnerIdentity) =>
  Match.valueTags(ending, {
    Done: () =>
      failure(
        "unusable-output",
        "The agent finished without handing in its Agent review. Try again.",
        runner,
      ),
    Failed: ({ reason }) => failure("runner", reason, runner),
    Stopped: () =>
      failure("runner", "The agent was stopped before it finished. Try again.", runner),
    CutOff: () => failure("runner", "Glass lost the agent before it finished. Try again.", runner),
    Interrupted: () =>
      failure("runner", "Glass lost the agent before it finished. Try again.", runner),
  })

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
    readonly cancel: (pr: PullRequestRef) => Effect.Effect<void>
    readonly markDone: (
      pr: PullRequestRef,
      writtenAt: DateTime.Utc,
    ) => Effect.Effect<void, AgentReviewFailure>
    readonly markIncludedInStartedWorkUpdate: (
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
      const threads = yield* Threads
      const fs = yield* FileSystem.FileSystem
      const scope = yield* Scope.Scope

      const where = (pr: PullRequestRef) =>
        sql`owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`

      const load = Effect.fnUntraced(
        function* (pr: PullRequestRef) {
          const rows =
            yield* sql`SELECT base, head, written_at, markdown, hotspots, low_attention, thread_id, done, included_in_started_work_update FROM agent_reviews WHERE ${where(pr)}`.pipe(
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
                  threadId: row.thread_id,
                  done: row.done,
                  includedInStartedWorkUpdate: row.included_in_started_work_update,
                })

          return review
        },
        logStorageFailure,
        Effect.mapError(storageFailure),
      )

      const jobs = yield* pullRequestJobs({ load, toState, backgroundSlots: BACKGROUND_SLOTS })

      const removeThread = (threadId: string | null) =>
        threadId === null
          ? Effect.void
          : threads.remove(threadId).pipe(
              Effect.catchTag("ThreadNotFound", () => Effect.void),
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't remove an Agent review's Thread", cause),
              ),
            )

      const reviewFolder = (threadId: string) =>
        join(config.dataDirectory, "agent-review-checkouts", threadId)

      const runsOf = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
        query.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(StoredRuns)),
          Effect.map((rows) =>
            rows.map((row): Run => ({
              pr: new PullRequestRef({ owner: row.owner, repo: row.repo, number: row.number }),
              threadId: row.thread_id,
              revision: new Revision({ base: row.base, head: row.head }),
              startedAt: row.started_at,
              runner: row.runner,
              background: row.background,
              diff: row.diff,
            })),
          ),
          logStorageFailure,
          Effect.mapError(storageFailure),
        )

      const discard = (run: Run) =>
        removeThread(run.threadId).pipe(
          Effect.andThen(sql`DELETE FROM agent_review_run WHERE thread_id = ${run.threadId}`),
          Effect.catch((cause) => Effect.logWarning("Couldn't discard an Agent review", cause)),
        )

      const discardRuns = (query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>) =>
        runsOf(query).pipe(
          Effect.flatMap((runs) => Effect.forEach(runs, discard, { discard: true })),
          Effect.ignore,
        )

      const discardRunOf = (pr: PullRequestRef) =>
        discardRuns(sql`SELECT * FROM agent_review_run WHERE ${where(pr)}`)

      const save = (job: Job, run: Run, review: AgentReview) =>
        Effect.gen(function* () {
          const replaced = (yield* SubscriptionRef.get(job.state)).output?.threadId ?? null
          const { pr } = run

          yield* jobs.commit(
            job,
            Effect.all([
              sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, hotspots, low_attention, thread_id, done, included_in_started_work_update)
                VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown}, ${encodeHotspots(review.hotspots)}, ${encodeLowAttention(review.lowAttention)}, ${run.threadId}, 0, 0)
                ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown, hotspots = excluded.hotspots, low_attention = excluded.low_attention, thread_id = excluded.thread_id, done = 0, included_in_started_work_update = 0`,
              sql`DELETE FROM agent_review_run WHERE thread_id = ${run.threadId}`,
            ]).pipe(sql.withTransaction, logStorageFailure, Effect.mapError(storageFailure)),
            () => review,
          )

          yield* removeThread(replaced).pipe(Effect.forkIn(scope))
        })

      const reviewInstructions = settings.read().pipe(
        Effect.map((saved) => agentReviewInstructions(saved.reviewPrompt)),
        Effect.mapError((error) => failure("not-ready", error.message)),
      )

      const reviewer = settings.read().pipe(
        Effect.map((saved) => runnerIdentity(engineSettingsOf(saved, "agentReviews"))),
        Effect.mapError((error) => failure("not-ready", error.message)),
      )

      const started = Clock.currentTimeMillis.pipe(
        Effect.map((startedAt): Progress => ({ status: "reviewing", startedAt, runner: null })),
      )

      const firstTurnEnded = (threadId: string) =>
        threads.transcript(threadId).pipe(
          Stream.scan(() => emptyTranscript, applyTranscriptUpdate),
          Stream.map(({ turns: [first] }) =>
            first?.ended == null ? null : { parts: first.parts, ending: first.ended.ending },
          ),
          Stream.filter(Predicate.isNotNull),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        )

      const settled = (job: Job) =>
        jobs.settle(
          job,
          "AgentReview",
          (error: Option.Option<AgentReviewFailure>, { runner }): Failed => ({
            status: "failed",
            reason: Option.getOrElse(error, () => stoppedRunner(runner)),
          }),
        )

      const follow = (job: Job, run: Run) =>
        Effect.gen(function* () {
          const remaining =
            run.startedAt + deadlines.agentReviewMs - (yield* Clock.currentTimeMillis)

          const { parts, ending } = yield* firstTurnEnded(run.threadId).pipe(
            Effect.timeoutOrElse({
              duration: Math.max(0, remaining),
              orElse: () =>
                threads
                  .stop(run.threadId)
                  .pipe(
                    Effect.ignore,
                    Effect.andThen(
                      Effect.fail(
                        failure(
                          "timeout",
                          "The agent took too long writing the Agent review. Try again.",
                          run.runner,
                        ),
                      ),
                    ),
                  ),
            }),
            Effect.catchTags({
              ThreadNotFound: () =>
                Effect.fail(failure("runner", "The Agent review's Thread was removed. Try again.")),
              ThreadError: ({ message }) => Effect.fail(failure("runner", message, run.runner)),
            }),
            Effect.tapError(() => discard(run)),
          )

          const answer = parts.reduce<AgentReviewAnswer | null>(
            (found, part) =>
              Predicate.isTagged(part, "ToolCall") ? (submittedReviewOf(part) ?? found) : found,
            null,
          )

          if (answer === null) {
            yield* discard(run)

            return yield* unfinished(ending, run.runner)
          }

          const review = AgentReview.make({
            revision: run.revision,
            writtenAt: yield* DateTime.now,
            markdown: answer.markdown,
            ...fitToDiff(answer, run.diff),
            threadId: run.threadId,
            done: false,
            includedInStartedWorkUpdate: false,
          })

          yield* threads
            .dropReviewCheckout(run.threadId)
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Couldn't drop an Agent review's checkout", cause),
              ),
            )

          return yield* save(job, run, review)
        })

      const begin = (run: Run, folder: string, instructions: string, prompt: string) =>
        Effect.gen(function* () {
          const { pr, revision, runner } = run

          yield* sql`INSERT INTO agent_review_run ${sql.insert({
            owner: pr.owner,
            repo: pr.repo,
            number: pr.number,
            thread_id: run.threadId,
            base: revision.base,
            head: revision.head,
            started_at: run.startedAt,
            runner: encodeRunner(runner),
            background: run.background ? 1 : 0,
            diff: encodeDiff(run.diff),
          })}`.pipe(logStorageFailure, Effect.mapError(storageFailure))

          yield* threads
            .createForReview({
              id: run.threadId,
              name: `Agent review of ${pr.owner}/${pr.repo}#${pr.number}`,
              pullRequest: pr,
              revision,
              harness: runner.harness,
              model: threadModelOf(runner),
              checkout: folder,
              review: { instructions, diffLines: run.diff.lines },
              message: prompt,
            })
            .pipe(
              Effect.mapError(({ message }) => failure("runner", message, runner)),
              Effect.tapError(() =>
                sql`DELETE FROM agent_review_run WHERE thread_id = ${run.threadId}`.pipe(
                  Effect.ignore,
                ),
              ),
            )
        }).pipe(Effect.uninterruptible)

      const work = (job: Job, pr: PullRequestRef, revision: Revision, background: boolean) =>
        Effect.gen(function* () {
          yield* discardRunOf(pr)

          const runner = yield* reviewer
          const startedAt = yield* Clock.currentTimeMillis
          yield* jobs.progress(job, () => ({ status: "reviewing", startedAt, runner }))

          const threadId = randomUUID()
          const folder = reviewFolder(threadId)

          const removeFolder = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit)
                  ? Effect.void
                  : fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
              ),
            )

          const input = yield* checkoutRuns
            .copy({ pr, revision, subject: "Agent review", folder, read: github.reviewInput })
            .pipe(Effect.mapError(fromCheckoutRunFailure), removeFolder)

          const instructions = yield* reviewInstructions.pipe(removeFolder)

          const run: Run = {
            pr,
            threadId,
            revision,
            startedAt,
            runner,
            background,
            diff: diffOf(input.files),
          }

          yield* begin(run, folder, instructions, agentReviewPrompt(input, revision)).pipe(
            removeFolder,
          )

          yield* follow(job, run)
        }).pipe(settled(job))

      const start = Effect.fn("AgentReviews.start")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.flatMap(started, (progress) => replace(progress, work(job, pr, revision, false))),
        )
      })

      const startInBackground = Effect.fn("AgentReviews.startInBackground")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        yield* jobs.startInBackground(pr, started, (job) => work(job, pr, revision, true))
      })

      const cancel = (pr: PullRequestRef) => jobs.stop(pr).pipe(Effect.andThen(discardRunOf(pr)))

      const cancelBackground = () =>
        jobs
          .stopBackground()
          .pipe(
            Effect.andThen(discardRuns(sql`SELECT * FROM agent_review_run WHERE background = 1`)),
          )

      const mark = (flag: "done" | "includedInStartedWorkUpdate", name: string) =>
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

              const column = flag === "done" ? "done" : "included_in_started_work_update"

              yield* sql`UPDATE agent_reviews SET ${sql(column)} = 1 WHERE ${where(pr)}`.pipe(
                logStorageFailure,
                Effect.mapError(storageFailure),
              )

              return { ...review, [flag]: true }
            }),
          )
        })

      const running = yield* runsOf(sql`SELECT * FROM agent_review_run`).pipe(
        Effect.orElseSucceed(() => []),
      )

      yield* Effect.forEach(
        running,
        (run) =>
          jobs
            .resume(
              run.pr,
              run.background,
              { status: "reviewing", startedAt: run.startedAt, runner: run.runner },
              (job) => follow(job, run).pipe(settled(job)),
            )
            .pipe(Effect.ignore),
        { discard: true },
      )

      return AgentReviews.of({
        start,
        startInBackground,
        cancel,
        markDone: mark("done", "AgentReviews.markDone"),
        markIncludedInStartedWorkUpdate: mark(
          "includedInStartedWorkUpdate",
          "AgentReviews.markIncludedInStartedWorkUpdate",
        ),
        cancelBackground,
        watch: jobs.watch,
      })
    }),
  )
}

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
import { SqlClient } from "effect/sql"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { type AgentReviewAnswer, submittedReviewOf } from "./agentHost/submitReviewTool"
import { agentReviewInstructions, agentReviewPrompt, MAX_HOTSPOTS } from "./agentReviewPrompt"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { patchLineNumbers, rangeInFiles } from "./github/patchLines"
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

interface Run {
  readonly pr: PullRequestRef
  readonly threadId: string
  readonly revision: Revision
  readonly runner: AgentRunnerIdentity
  readonly files: ReadonlyArray<ChangedFile>
}

const diffLinesOn = (files: ReadonlyArray<ChangedFile>, side: DiffSide) =>
  Object.fromEntries(
    files.flatMap(({ path, patch }) =>
      Predicate.isTagged(patch, "TextPatch") ? [[path, patchLineNumbers(patch.hunks, side)]] : [],
    ),
  )

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

const lost = (runner: AgentRunnerIdentity) =>
  failure("runner", "Glass lost the agent before it finished. Try again.", runner)

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
    CutOff: () => lost(runner),
    Interrupted: () => lost(runner),
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

      const checkoutsFolder = join(config.dataDirectory, "agent-review-checkouts")

      const keptThreads = sql<{ readonly threadId: string }>`
        SELECT thread_id AS threadId FROM agent_reviews WHERE thread_id IS NOT NULL
      `.pipe(Effect.map((rows) => new Set(rows.map(({ threadId }) => threadId))))

      const removeUnlessKept = (threadId: string) =>
        sql`SELECT 1 FROM agent_reviews WHERE thread_id = ${threadId}`.pipe(
          Effect.flatMap((rows) => (rows.length > 0 ? Effect.void : removeThread(threadId))),
          Effect.catch((cause) =>
            Effect.logWarning("Couldn't check whether an Agent review keeps its Thread", cause),
          ),
        )

      const unkept = Effect.gen(function* () {
        const { kept, reviewThreads, entries } = yield* Effect.all(
          {
            kept: keptThreads,
            reviewThreads: threads.reviewThreads,
            entries: fs
              .readDirectory(checkoutsFolder)
              .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
          },
          { concurrency: "unbounded" },
        )

        const keptFolders = reviewThreads.flatMap(({ id, folder }) =>
          kept.has(id) ? [folder] : [],
        )

        return {
          threadIds: reviewThreads.flatMap(({ id }) => (kept.has(id) ? [] : [id])),
          paths: entries
            .map((entry) => join(checkoutsFolder, entry))
            .filter(
              (path) =>
                !keptFolders.some((folder) => path === folder || path.startsWith(`${folder}.`)),
            ),
        }
      })

      const removeAll = ({ threadIds, paths }: Effect.Success<typeof unkept>) =>
        Effect.forEach(threadIds, removeThread, { discard: true }).pipe(
          Effect.andThen(
            Effect.forEach(
              paths,
              (path) =>
                fs.remove(path, { recursive: true, force: true }).pipe(
                  Effect.ignore({
                    log: "Warn",
                    message: "Couldn't remove an Agent review's checkout",
                  }),
                ),
              { discard: true },
            ),
          ),
        )

      const save = (job: Job, run: Run, review: AgentReview) =>
        Effect.gen(function* () {
          const replaced = (yield* SubscriptionRef.get(job.state)).output?.threadId ?? null
          const { pr } = run

          yield* jobs.commit(
            job,
            sql`INSERT INTO agent_reviews (owner, repo, number, base, head, written_at, markdown, hotspots, low_attention, thread_id, done, included_in_started_work_update)
                VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${review.revision.base}, ${review.revision.head}, ${DateTime.formatIso(review.writtenAt)}, ${review.markdown}, ${encodeHotspots(review.hotspots)}, ${encodeLowAttention(review.lowAttention)}, ${run.threadId}, 0, 0)
                ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, markdown = excluded.markdown, hotspots = excluded.hotspots, low_attention = excluded.low_attention, thread_id = excluded.thread_id, done = 0, included_in_started_work_update = 0`.pipe(
              logStorageFailure,
              Effect.mapError(storageFailure),
            ),
            () => review,
          )

          yield* removeThread(replaced).pipe(Effect.forkIn(scope))
        })

      const reviewSettings = settings.read().pipe(
        Effect.map((saved) => ({
          runner: runnerIdentity(engineSettingsOf(saved, "agentReviews")),
          instructions: agentReviewInstructions(saved.reviewPrompt),
        })),
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

      const follow = (job: Job, run: Run) =>
        Effect.gen(function* () {
          const { parts, ending } = yield* firstTurnEnded(run.threadId).pipe(
            Effect.timeoutOrElse({
              duration: deadlines.agentReviewMs,
              orElse: () =>
                Effect.fail(
                  failure(
                    "timeout",
                    "The agent took too long writing the Agent review. Try again.",
                    run.runner,
                  ),
                ),
            }),
            Effect.catchTags({
              ThreadNotFound: () =>
                Effect.fail(failure("runner", "The Agent review's Thread was removed. Try again.")),
              ThreadError: ({ message }) => Effect.fail(failure("runner", message, run.runner)),
            }),
          )

          const answer = parts.reduce<AgentReviewAnswer | null>(
            (found, part) =>
              Predicate.isTagged(part, "ToolCall") ? (submittedReviewOf(part) ?? found) : found,
            null,
          )

          if (answer === null) return yield* unfinished(ending, run.runner)

          const review = AgentReview.make({
            revision: run.revision,
            writtenAt: yield* DateTime.now,
            markdown: answer.markdown,
            ...fitToDiff(answer, run.files),
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

      const work = (job: Job, pr: PullRequestRef, revision: Revision) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const { runner, instructions } = yield* restore(reviewSettings)
            yield* jobs.progress(job, (progress) => ({ ...progress, runner }))

            const threadId = randomUUID()
            const folder = join(checkoutsFolder, threadId)

            const input = yield* restore(
              checkoutRuns
                .copy({ pr, revision, subject: "Agent review", folder, read: github.reviewInput })
                .pipe(Effect.mapError(fromCheckoutRunFailure)),
            ).pipe(
              Effect.tap((copied) =>
                threads.createForReview({
                  id: threadId,
                  name: `Agent review of ${pr.owner}/${pr.repo}#${pr.number}`,
                  pullRequest: pr,
                  revision,
                  harness: runner.harness,
                  model: threadModelOf(runner),
                  checkout: folder,
                  review: {
                    instructions,
                    diffLines: {
                      old: diffLinesOn(copied.files, "old"),
                      new: diffLinesOn(copied.files, "new"),
                    },
                  },
                  message: agentReviewPrompt(copied, revision),
                }),
              ),
              Effect.mapError((error) =>
                Predicate.isTagged(error, "ThreadError")
                  ? failure("runner", error.message, runner)
                  : error,
              ),
              Effect.onError(() =>
                fs.remove(folder, { recursive: true, force: true }).pipe(Effect.ignore),
              ),
            )

            yield* restore(
              follow(job, { pr, threadId, revision, runner, files: input.files }),
            ).pipe(
              Effect.onExit((exit) =>
                Exit.isSuccess(exit) ? Effect.void : removeUnlessKept(threadId),
              ),
            )
          }),
        ).pipe(
          jobs.settle(
            job,
            "AgentReview",
            (error: Option.Option<AgentReviewFailure>, { runner }): Failed => ({
              status: "failed",
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

      yield* unkept.pipe(
        Effect.flatMap((found) => removeAll(found).pipe(Effect.forkIn(scope))),
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't remove what no Agent review keeps", cause),
        ),
      )

      return AgentReviews.of({
        start,
        startInBackground,
        cancel: jobs.stop,
        markDone: mark("done", "AgentReviews.markDone"),
        markIncludedInStartedWorkUpdate: mark(
          "includedInStartedWorkUpdate",
          "AgentReviews.markIncludedInStartedWorkUpdate",
        ),
        cancelBackground: jobs.stopBackground,
        watch: jobs.watch,
      })
    }),
  )
}

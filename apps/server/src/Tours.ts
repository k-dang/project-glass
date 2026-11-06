import {
  Chapter,
  type ChangedFile,
  type PullRequestRef,
  Revision,
  Tour,
  TourFailure,
  type TourState,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { SqlClient } from "effect/sql"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { ServerConfig } from "./ServerConfig"
import { TourAnswer, tourInstructions, tourPrompt } from "./tourPrompt"
import { repairChapterVisuals, validateTourBeforeAfter } from "./tourVisuals"

const BACKGROUND_SLOTS = 2

type Job = PullRequestJob<TourState>

const content = Schema.Struct({
  intent: Tour.fields.intent,
  beforeAfter: Tour.fields.beforeAfter,
  chapters: Tour.fields.chapters,
  everythingElse: Tour.fields.everythingElse,
})

const stored = Schema.Array(
  Schema.Struct({
    base: Schema.String,
    head: Schema.String,
    written_at: Schema.DateTimeUtcFromString,
    content: Schema.fromJsonString(content),
  }),
)

const setJob = (job: Job, status: TourState["job"]) =>
  SubscriptionRef.update(job.state, ({ tour }) => ({ tour, job: status }))

const storageFailure = () =>
  new TourFailure({
    reason: "storage",
    message: "Couldn't load or save your Tour. Try again.",
    runner: null,
  })

const logStorageFailure = Effect.tapError((cause: unknown) =>
  Effect.logWarning("Couldn't load or save a Tour", cause),
)

const fromCheckoutRunFailure = ({ reason, message, runner }: CheckoutRunFailure) =>
  new TourFailure({ reason, message, runner })

const repair = (answer: TourAnswer, changedFiles: ReadonlyArray<ChangedFile>) => {
  const remaining = new Set(changedFiles.map((file) => file.path))
  const chapters: Array<Chapter> = []

  for (const chapter of answer.chapters) {
    const files = chapter.files.filter(({ path }) => remaining.delete(path))

    if (files.length > 0 || chapter.explanation.trim() !== "")
      chapters.push(repairChapterVisuals({ ...chapter, files }, changedFiles))
  }

  const everythingElse = [
    ...new Set([...answer.unplacedFiles.filter((path) => remaining.has(path)), ...remaining]),
  ]

  const beforeAfter =
    answer.beforeAfter == null ? null : validateTourBeforeAfter(answer.beforeAfter, changedFiles)

  return { intent: answer.intent, beforeAfter, chapters, everythingElse }
}

export class Tours extends Context.Service<
  Tours,
  {
    readonly write: (pr: PullRequestRef, revision: Revision) => Effect.Effect<void, TourFailure>
    readonly writeInBackground: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<void, TourFailure>
    readonly cancel: (pr: PullRequestRef) => Effect.Effect<void>
    readonly cancelBackground: () => Effect.Effect<void>
    readonly watch: (pr: PullRequestRef) => Stream.Stream<TourState, TourFailure>
  }
>()("@glass/server/Tours") {
  static readonly layer = Layer.effect(
    Tours,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const github = yield* GitHubClient
      const config = yield* ServerConfig
      const checkoutRuns = yield* CheckoutRuns

      const load = Effect.fnUntraced(function* (pr: PullRequestRef) {
        const rows =
          yield* sql`SELECT base, head, written_at, content FROM tours WHERE owner = ${pr.owner} AND repo = ${pr.repo} AND number = ${pr.number}`.pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(stored)),
            logStorageFailure,
            Effect.mapError(storageFailure),
          )

        const row = rows[0]

        const tour =
          row === undefined
            ? null
            : Tour.make({
                revision: new Revision({ base: row.base, head: row.head }),
                writtenAt: row.written_at,
                ...row.content,
              })

        return { tour, job: { status: "idle" } } satisfies TourState
      })

      const jobs = yield* pullRequestJobs<TourState, TourFailure>({
        load,
        inProgress: ({ job }) => job.status === "writing" || job.status === "waiting",
        idle: ({ tour }) => ({ tour, job: { status: "idle" } }),
        backgroundSlots: BACKGROUND_SLOTS,
        needsBackground: ({ tour, job }) => tour === null && job.status === "idle",
        waiting: ({ tour }) => ({ tour, job: { status: "waiting" } }),
      })

      const markWriting = Effect.fnUntraced(function* (job: Job) {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
        yield* setJob(job, { status: "writing", startedAt, runner: null })

        return startedAt
      })

      const work = (job: Job, pr: PullRequestRef, revision: Revision, startedAt: number) =>
        Effect.gen(function* () {
          const selected = yield* checkoutRuns
            .select("tours")
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          const runner = selected.identity
          yield* setJob(job, { status: "writing", startedAt, runner })

          const { input, answer } = yield* selected
            .run({
              pr,
              revision,
              subject: "Tour",
              timeout: config.tourTimeoutMs,
              read: github.tourInput,
              task: (material) =>
                Effect.succeed({
                  instructions: tourInstructions,
                  prompt: tourPrompt(material),
                  answer: TourAnswer,
                }),
            })
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          const repaired = repair(answer, input.files)

          if (answer.beforeAfter != null && repaired.beforeAfter === null)
            yield* Effect.logWarning(
              "Dropped a Tour's Before / after: it changed nothing or a changed line isn't in the diff",
            )

          if (repaired.chapters.length === 0)
            return yield* new TourFailure({
              reason: "unusable-output",
              message: "The agent returned no usable Chapters. Try again.",
              runner,
            })
          const writtenAt = yield* DateTime.now
          const tour: Tour = { revision, writtenAt, ...repaired }

          return yield* jobs.commit(
            job,
            sql`INSERT INTO tours (owner, repo, number, base, head, written_at, content)
            VALUES (${pr.owner}, ${pr.repo}, ${pr.number}, ${revision.base}, ${revision.head}, ${DateTime.formatIso(writtenAt)}, ${JSON.stringify(repaired)})
            ON CONFLICT (owner, repo, number) DO UPDATE SET base = excluded.base, head = excluded.head, written_at = excluded.written_at, content = excluded.content`.pipe(
              logStorageFailure,
              Effect.mapError(storageFailure),
            ),
            { tour, job: { status: "idle" } },
          )
        }).pipe(
          Effect.scoped,
          jobs.settle(job, "Tour", ({ tour, job: current }, error: Option.Option<TourFailure>) => ({
            tour,
            job: {
              status: "failed",
              reason: Option.getOrElse(
                error,
                () =>
                  new TourFailure({
                    reason: "runner",
                    message:
                      "The agent runner stopped unexpectedly. Check its installation and try again.",
                    runner: current.status === "writing" ? current.runner : null,
                  }),
              ),
            },
          })),
        )

      const write = Effect.fn("Tours.write")(function* (pr: PullRequestRef, revision: Revision) {
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            const startedAt = yield* markWriting(job)
            yield* replace(work(job, pr, revision, startedAt))
          }),
        )
      })

      const writeInBackground = Effect.fn("Tours.writeInBackground")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        yield* jobs.startInBackground(pr, (job) =>
          markWriting(job).pipe(Effect.flatMap((startedAt) => work(job, pr, revision, startedAt))),
        )
      })

      return Tours.of({
        write,
        writeInBackground,
        cancel: jobs.stop,
        cancelBackground: jobs.stopBackground,
        watch: jobs.watch,
      })
    }),
  )
}

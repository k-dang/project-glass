import {
  type AgentRunnerIdentity,
  Chapter,
  type ChangedFile,
  type PullRequestRef,
  Revision,
  Tour,
  TourFailure,
  type TourState,
} from "@glass/contracts"
import { Clock, Context, DateTime, Effect, Layer, Option, Schema, Stream } from "effect"
import { SqlClient } from "effect/sql"
import { type CheckoutRunFailure, CheckoutRuns } from "./CheckoutRuns"
import { GitHubClient } from "./github/GitHubClient"
import { type JobState, pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { Deadlines } from "./ServerConfig"
import { TourAnswer, tourInstructions, tourPrompt } from "./tourPrompt"
import { repairChapterVisuals, validateTourBeforeAfter } from "./tourVisuals"

const BACKGROUND_SLOTS = 2

interface Progress {
  readonly startedAt: number
  readonly runner: AgentRunnerIdentity | null
}

type Job = PullRequestJob<Tour, Progress, TourFailure>

const toState = ({ output, run }: JobState<Tour, Progress, TourFailure>): TourState => {
  if (run.status === "running") return { tour: output, job: { status: "writing", ...run.progress } }

  if (run.status === "failed")
    return { tour: output, job: { status: "failed", reason: run.failure } }

  return { tour: output, job: { status: run.status } }
}

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
      const deadlines = yield* Deadlines
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

        return tour
      })

      const jobs = yield* pullRequestJobs({ load, toState, backgroundSlots: BACKGROUND_SLOTS })

      const started = Clock.currentTimeMillis.pipe(
        Effect.map((startedAt): Progress => ({ startedAt, runner: null })),
      )

      const work = (job: Job, pr: PullRequestRef, revision: Revision) =>
        Effect.gen(function* () {
          const selected = yield* checkoutRuns
            .select("tours")
            .pipe(Effect.mapError(fromCheckoutRunFailure))

          const runner = selected.identity
          yield* jobs.progress(job, (progress) => ({ ...progress, runner }))

          const { input, answer } = yield* selected
            .run({
              pr,
              revision,
              subject: "Tour",
              timeout: deadlines.tourMs,
              read: github.tourInput,
              task: (material) =>
                Effect.succeed({
                  instructions: tourInstructions,
                  prompt: tourPrompt(material),
                  answer: TourAnswer,
                  tools: "read-only",
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
            () => tour,
          )
        }).pipe(
          Effect.scoped,
          jobs.settle(job, "Tour", (error: Option.Option<TourFailure>, { runner }) =>
            Option.getOrElse(
              error,
              () =>
                new TourFailure({
                  reason: "runner",
                  message:
                    "The agent runner stopped unexpectedly. Check its installation and try again.",
                  runner,
                }),
            ),
          ),
        )

      const write = Effect.fn("Tours.write")(function* (pr: PullRequestRef, revision: Revision) {
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.flatMap(started, (progress) => replace(progress, work(job, pr, revision))),
        )
      })

      const writeInBackground = Effect.fn("Tours.writeInBackground")(function* (
        pr: PullRequestRef,
        revision: Revision,
      ) {
        yield* jobs.startInBackground(pr, started, (job) => work(job, pr, revision))
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

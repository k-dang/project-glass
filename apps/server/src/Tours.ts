import {
  Chapter,
  type PullRequestRef,
  Revision,
  Tour,
  TourFailure,
  type TourState,
} from "@glass/contracts"
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect"
import { SqlClient } from "effect/sql"
import { GitHubClient } from "./github/GitHubClient"
import { pullRequestJobs, type PullRequestJob } from "./pullRequestJobs"
import { ServerConfig } from "./ServerConfig"
import { engineSettingsOf, SettingsStore } from "./SettingsStore"
import type { AgentFailure } from "./agentFailure"
import { AgentRunners } from "./agentRunners"
import { TourAnswer, tourInstructions, tourPrompt } from "./tourPrompt"

const BACKGROUND_SLOTS = 2

type Job = PullRequestJob<TourState>

const content = Schema.Struct({
  intent: Tour.fields.intent,
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

const needsTour = ({ tour, job }: TourState) => tour === null && job.status === "idle"

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

const fromAgentFailure = ({ reason, message, runner }: AgentFailure) =>
  new TourFailure({
    reason: reason === "failed" ? "runner" : reason,
    message,
    runner,
  })

const repair = (answer: TourAnswer, paths: ReadonlyArray<string>) => {
  const remaining = new Set(paths)
  const chapters: Array<Chapter> = []

  for (const chapter of answer.chapters) {
    const files = chapter.files.filter(({ path }) => remaining.delete(path))

    if (files.length > 0 || chapter.explanation.trim() !== "") chapters.push({ ...chapter, files })
  }

  const everythingElse = [
    ...new Set([...answer.unplacedFiles.filter((path) => remaining.has(path)), ...remaining]),
  ]

  return { intent: answer.intent, chapters, everythingElse }
}

export class Tours extends Context.Service<
  Tours,
  {
    readonly write: (pr: PullRequestRef, revision: Revision) => Effect.Effect<void, TourFailure>
    readonly writeInBackground: (
      pr: PullRequestRef,
      revision: Revision,
    ) => Effect.Effect<void, TourFailure>
    readonly cancel: (pr: PullRequestRef) => Effect.Effect<void, TourFailure>
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
      const settings = yield* SettingsStore
      const runners = yield* AgentRunners
      const backgroundSlots = yield* Semaphore.make(BACKGROUND_SLOTS)

      const engineSettings = settings.read().pipe(
        Effect.map((current) => engineSettingsOf(current, "tours")),
        Effect.mapError(
          (error) => new TourFailure({ reason: "not-ready", message: error.message, runner: null }),
        ),
      )

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
      })

      const markWriting = Effect.fnUntraced(function* (job: Job) {
        const startedAt = DateTime.toEpochMillis(yield* DateTime.now)
        yield* setJob(job, { status: "writing", startedAt, runner: null })

        return startedAt
      })

      const work = (job: Job, pr: PullRequestRef, revision: Revision, startedAt: number) =>
        Effect.gen(function* () {
          const selected = yield* runners
            .select(yield* engineSettings, "none")
            .pipe(Effect.mapError(fromAgentFailure))

          const runner = selected.identity
          yield* setJob(job, { status: "writing", startedAt, runner })

          const input = yield* github.tourInput(pr, revision).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Couldn't read the Revision for a Tour", cause),
            ),
            Effect.mapError(
              () =>
                new TourFailure({
                  reason: "github",
                  message:
                    "Couldn't read the requested Revision from GitHub. Reload the PR and try again.",
                  runner,
                }),
            ),
          )

          const answer = yield* selected
            .run({
              subject: "Tour",
              instructions: tourInstructions,
              prompt: tourPrompt(input),
              answer: TourAnswer,
              files: "none",
            })
            .pipe(Effect.mapError(fromAgentFailure))

          const repaired = repair(
            answer,
            input.files.map((file) => file.path),
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
          Effect.timeoutOrElse({
            duration: config.tourTimeoutMs,
            orElse: () =>
              Effect.gen(function* () {
                const { job: current } = yield* SubscriptionRef.get(job.state)

                return yield* new TourFailure({
                  reason: "timeout",
                  message: "Writing the Tour took too long. Try again.",
                  runner: current.status === "writing" ? current.runner : null,
                })
              }),
          }),
          jobs.settle(job, ({ tour, job: current }, error: Option.Option<TourFailure>) => ({
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
        const job = yield* jobs.jobFor(pr)

        yield* jobs.begin(job, (replace) =>
          Effect.gen(function* () {
            if (!needsTour(yield* SubscriptionRef.get(job.state))) return

            yield* setJob(job, { status: "waiting" })

            const writeInSlot = backgroundSlots.withPermits(1)(
              markWriting(job).pipe(
                Effect.flatMap((startedAt) => work(job, pr, revision, startedAt)),
              ),
            )

            yield* replace(writeInSlot, true)
          }),
        )
      })

      const cancel = Effect.fn("Tours.cancel")(function* (pr: PullRequestRef) {
        yield* jobs.stop(yield* jobs.jobFor(pr))
      })

      const cancelBackground = Effect.fn("Tours.cancelBackground")(function* () {
        yield* jobs.stopBackground()
      })

      return Tours.of({
        write,
        writeInBackground,
        cancel,
        cancelBackground,
        watch: jobs.watch,
      })
    }),
  )
}

import {
  type ConnectionError,
  GitHubUnavailable,
  type PullRequestRef,
  PullRequestState,
  PullRequestSummary,
  QueueAddition,
  QueuedPullRequest,
  QueueError,
  referenceKey,
  Revision,
  type SettingsError,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Schema, Semaphore } from "effect"
import { SqlClient } from "effect/sql"
import { GitHubClient } from "./github/GitHubClient"
import type { LookedUpPullRequest } from "./github/queuedPullRequests"
import { SettingsStore } from "./SettingsStore"
import { Tours } from "./Tours"

const decodeRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      queuedAt: Schema.DateTimeUtcFromString,
      pullRequest: Schema.fromJsonString(PullRequestSummary),
      state: PullRequestState,
      openedSinceQueued: Schema.BooleanFromBit,
      missing: Schema.BooleanFromBit,
      base: Schema.NullOr(Schema.String),
      head: Schema.NullOr(Schema.String),
    }),
  ),
)

const decodeSummary = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestSummary))

const encodeSummary = Schema.encodeEffect(Schema.fromJsonString(PullRequestSummary))

const loadFailed = () => new QueueError({ message: "Couldn't load your Queue. Try again." })

const saveFailed = () => new QueueError({ message: "Couldn't save your Queue. Try again." })

const missingProblem = new GitHubUnavailable({
  message: "GitHub no longer gives Glass this PR. It may be gone, or this Connection can't see it.",
})

const keyOf = (queued: QueuedPullRequest) => referenceKey(queued.pullRequest.ref)

type Saved = Omit<LookedUpPullRequest, "revision"> & { readonly revision: Revision | null }

type TourCandidate = Pick<QueuedPullRequest, "pullRequest" | "state" | "revision" | "problem">

export class Queue extends Context.Service<
  Queue,
  {
    readonly saved: () => Effect.Effect<ReadonlyArray<QueuedPullRequest>, QueueError>
    readonly refresh: () => Effect.Effect<void, QueueError | ConnectionError>
    readonly add: (
      references: ReadonlyArray<PullRequestRef>,
    ) => Effect.Effect<QueueAddition, QueueError | ConnectionError>
    readonly remove: (
      reference: PullRequestRef,
    ) => Effect.Effect<QueuedPullRequest | null, QueueError>
    readonly restore: (queued: QueuedPullRequest) => Effect.Effect<void, QueueError>
    readonly opened: (reference: PullRequestRef) => Effect.Effect<void>
    readonly reviewed: (pullRequestId: string) => Effect.Effect<void>
    readonly toursEnabled: () => Effect.Effect<boolean, SettingsError>
    readonly setToursEnabled: (enabled: boolean) => Effect.Effect<void, SettingsError>
  }
>()("@glass/server/Queue") {
  static readonly layer = Layer.effect(
    Queue,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const github = yield* GitHubClient
      const tours = yield* Tours
      const settings = yield* SettingsStore
      // Starting Tours and turning them off take turns, so none starts after they're off.
      const toursLock = yield* Semaphore.make(1)
      const now = DateTime.now.pipe(Effect.map(DateTime.formatIso))

      const read = Effect.gen(function* () {
        const rows = yield* sql`
          SELECT
            node_id AS id,
            queued_at AS queuedAt,
            summary AS pullRequest,
            state,
            opened_at IS NOT NULL AS openedSinceQueued,
            missing,
            base,
            head
          FROM queued_pull_request
          ORDER BY queued_at, reference_key
        `

        return (yield* decodeRows(rows)).map(
          ({ missing, base, head, ...row }) =>
            new QueuedPullRequest({
              ...row,
              revision: base === null || head === null ? null : new Revision({ base, head }),
              problem: missing ? missingProblem : null,
            }),
        )
      }).pipe(
        Effect.tapError((cause) => Effect.logWarning("Couldn't load the Queue", cause)),
        Effect.mapError(loadFailed),
      )

      const logSaveFailure = Effect.tapError((cause: unknown) =>
        Effect.logWarning("Couldn't save the Queue", cause),
      )

      const toursEnabled = () => settings.read().pipe(Effect.map(({ queueTours }) => queueTours))

      const startTour = ({ pullRequest, state, revision, problem }: TourCandidate) =>
        problem !== null || revision === null || state === "merged" || state === "closed"
          ? Effect.void
          : tours
              .writeInBackground(pullRequest.ref, revision)
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning("Couldn't start a Tour for a queued PR", cause),
                ),
              )

      const startTours = (candidates: ReadonlyArray<TourCandidate>) =>
        toursEnabled().pipe(
          Effect.flatMap((enabled) =>
            enabled ? Effect.forEach(candidates, startTour, { discard: true }) : Effect.void,
          ),
          Effect.catch((cause) => Effect.logWarning("Couldn't start Tours for the Queue", cause)),
          toursLock.withPermits(1),
        )

      const cancelTour = (ref: PullRequestRef) =>
        tours
          .cancel(ref)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Couldn't cancel the Tour of a PR leaving the Queue", cause),
            ),
          )

      const insert = Effect.fnUntraced(function* (
        queuedAt: DateTime.Utc,
        { id, summary, state, revision }: Saved,
        marks: { readonly openedAt: string | null; readonly missing: boolean },
      ) {
        yield* sql`
          INSERT INTO queued_pull_request ${sql.insert({
            reference_key: referenceKey(summary.ref),
            node_id: id,
            queued_at: DateTime.formatIso(queuedAt),
            summary: yield* encodeSummary(summary),
            state,
            opened_at: marks.openedAt,
            missing: marks.missing ? 1 : 0,
            base: revision?.base ?? null,
            head: revision?.head ?? null,
          })}
          ON CONFLICT DO NOTHING
        `
      })

      const nextQueuedAt = Effect.gen(function* () {
        const [row] = yield* sql<{ readonly last: string | null }>`
          SELECT MAX(queued_at) AS last FROM queued_pull_request
        `

        const current = yield* DateTime.now

        return row?.last == null
          ? current
          : DateTime.max(current, DateTime.add(DateTime.makeUnsafe(row.last), { milliseconds: 1 }))
      })

      const update = Effect.fnUntraced(function* (
        queued: QueuedPullRequest,
        pullRequest: LookedUpPullRequest | null,
      ) {
        if (pullRequest === null) {
          return yield* sql`
            UPDATE queued_pull_request SET missing = 1 WHERE reference_key = ${keyOf(queued)}
          `
        }

        const { id, summary, state, revision } = pullRequest

        return yield* sql`
          UPDATE queued_pull_request
          SET ${sql.update({
            node_id: id,
            summary: yield* encodeSummary(summary),
            state,
            missing: 0,
            base: revision.base,
            head: revision.head,
          })}
          WHERE reference_key = ${keyOf(queued)}
        `
      })

      const add = Effect.fn("Queue.add")(function* (references: ReadonlyArray<PullRequestRef>) {
        const requested = [...new Map(references.map((ref) => [referenceKey(ref), ref])).values()]
        const queued = new Set((yield* read).map(keyOf))
        const alreadyQueued = requested.filter((ref) => queued.has(referenceKey(ref)))
        const unqueued = requested.filter((ref) => !queued.has(referenceKey(ref)))
        const found = unqueued.length === 0 ? [] : yield* github.queuedPullRequests(unqueued)
        const added: Array<LookedUpPullRequest> = []
        const notFound: Array<PullRequestRef> = []

        for (const [index, ref] of unqueued.entries()) {
          const pullRequest = found[index] ?? null

          if (pullRequest === null) notFound.push(ref)
          else if (queued.has(referenceKey(pullRequest.summary.ref))) alreadyQueued.push(ref)
          else {
            queued.add(referenceKey(pullRequest.summary.ref))
            added.push(pullRequest)
          }
        }

        yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const queuedAt = yield* nextQueuedAt

              yield* Effect.forEach(
                added,
                (pullRequest, index) =>
                  insert(DateTime.add(queuedAt, { milliseconds: index }), pullRequest, {
                    openedAt: null,
                    missing: false,
                  }),
                { discard: true },
              )
            }),
          )
          .pipe(logSaveFailure, Effect.mapError(saveFailed))

        yield* startTours(
          added.map(({ summary, state, revision }) => ({
            pullRequest: summary,
            state,
            revision,
            problem: null,
          })),
        )

        return new QueueAddition({
          added: added.map(({ summary }) => summary.ref),
          alreadyQueued,
          notFound,
        })
      })

      const refresh = Effect.fn("Queue.refresh")(function* () {
        const before = yield* read

        if (before.length === 0) return

        const found = yield* github.queuedPullRequests(
          before.map((queued) => queued.pullRequest.ref),
        )

        yield* sql
          .withTransaction(
            Effect.forEach(before, (queued, index) => update(queued, found[index] ?? null), {
              discard: true,
            }),
          )
          .pipe(logSaveFailure, Effect.mapError(saveFailed))
      })

      const remove = Effect.fn("Queue.remove")(function* (reference: PullRequestRef) {
        const key = referenceKey(reference)
        const removed = (yield* read).find((queued) => keyOf(queued) === key) ?? null

        yield* sql`DELETE FROM queued_pull_request WHERE reference_key = ${key}`.pipe(
          logSaveFailure,
          Effect.mapError(saveFailed),
        )

        if (removed !== null) yield* cancelTour(removed.pullRequest.ref)

        return removed
      })

      const restore = Effect.fn("Queue.restore")(function* (queued: QueuedPullRequest) {
        const openedAt = queued.openedSinceQueued ? yield* now : null

        yield* insert(
          queued.queuedAt,
          {
            id: queued.id,
            summary: queued.pullRequest,
            state: queued.state,
            revision: queued.revision,
          },
          { openedAt, missing: queued.problem !== null },
        ).pipe(logSaveFailure, Effect.mapError(saveFailed))

        yield* startTours([queued])
      })

      const opened = Effect.fn("Queue.opened")(
        function* (reference: PullRequestRef) {
          const openedAt = yield* now

          yield* sql`
            UPDATE queued_pull_request SET opened_at = ${openedAt}
            WHERE reference_key = ${referenceKey(reference)} AND opened_at IS NULL
          `
        },
        Effect.catch((cause) => Effect.logWarning("Couldn't mark a queued PR opened", cause)),
      )

      const reviewed = Effect.fn("Queue.reviewed")(
        function* (pullRequestId: string) {
          const rows = yield* sql<{ readonly summary: string }>`
            DELETE FROM queued_pull_request WHERE node_id = ${pullRequestId} RETURNING summary
          `

          yield* Effect.forEach(
            rows,
            ({ summary }) =>
              decodeSummary(summary).pipe(Effect.flatMap(({ ref }) => cancelTour(ref))),
            { discard: true },
          )
        },
        Effect.catch((cause) =>
          Effect.logWarning("Couldn't take a reviewed PR out of the Queue", cause),
        ),
      )

      const setToursEnabled = Effect.fn("Queue.setToursEnabled")(function* (enabled: boolean) {
        yield* settings.update((current) => ({ ...current, queueTours: enabled }))

        if (!enabled) yield* tours.cancelBackground()
      }, toursLock.withPermits(1))

      return Queue.of({
        saved: () => read,
        refresh,
        add,
        remove,
        restore,
        opened,
        reviewed,
        toursEnabled,
        setToursEnabled,
      })
    }),
  )
}

import { PullRequestRef, Revision, ThreadError } from "@glass/contracts"
import { Effect, type FileSystem, Option, Schema } from "effect"
import type { SqlClient } from "effect/sql"
import { ReviewBrief } from "./agentHost/protocol"
import { checkoutProblem, type Checkouts } from "./Checkouts"
import { keyedLock } from "./keyedLock"
import type { LocalPlacement } from "./LocalPlacement"
import type { PlacedThread, ThreadHosting } from "./Placement"

const ReviewedRevision = Schema.Struct({ pullRequest: PullRequestRef, revision: Revision })

export type ReviewedRevision = typeof ReviewedRevision.Type

const BriefJson = Schema.fromJsonString(ReviewBrief)

const ReviewedJson = Schema.fromJsonString(ReviewedRevision)

const encodeBrief = Schema.encodeSync(BriefJson)

const encodeReviewed = Schema.encodeSync(ReviewedJson)

const decodeReview = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ brief: BriefJson, reviewed: ReviewedJson })),
)

export const reviewColumns = (brief: ReviewBrief, reviewed: ReviewedRevision) => ({
  review_brief: encodeBrief(brief),
  reviewed_revision: encodeReviewed(reviewed),
})

export const stopOnHost = (hosting: ThreadHosting, row: PlacedThread) =>
  hosting.connectedHost(row).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (host) =>
          host
            .StopThread({ threadId: row.thread.id })
            .pipe(Effect.ignore({ log: "Warn", message: "Couldn't stop a Thread" })),
      }),
    ),
  )

export const reviewThreadHosting = (services: {
  readonly sql: SqlClient.SqlClient
  readonly fs: FileSystem.FileSystem
  readonly checkouts: typeof Checkouts.Service
  readonly localPlacement: typeof LocalPlacement.Service
  readonly storageFailure: () => ThreadError
}) => {
  const { sql, fs, checkouts, localPlacement, storageFailure } = services
  const checkoutLock = keyedLock()

  const review = (threadId: string) =>
    sql`SELECT review_brief AS brief, reviewed_revision AS reviewed FROM thread WHERE id = ${threadId}`.pipe(
      Effect.flatMap(decodeReview),
      Effect.tapError((cause) =>
        Effect.logWarning("Couldn't read a Review Thread's review", cause),
      ),
      Effect.mapError(storageFailure),
      Effect.flatMap(([found]) =>
        found === undefined
          ? Effect.fail(new ThreadError({ message: "This Thread was removed." }))
          : Effect.succeed(found),
      ),
    )

  // WARNING: Both harnesses find a session by its folder, so a Review Thread whose checkout was dropped gets it back at the same path.
  const checkedOut = ({ thread, folder }: PlacedThread) =>
    checkoutLock.withLock(
      thread.id,
      Effect.gen(function* () {
        if (yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false))) return

        const { reviewed } = yield* review(thread.id)

        yield* checkouts
          .checkoutInto(reviewed.pullRequest, reviewed.revision, folder)
          .pipe(Effect.mapError((error) => new ThreadError({ message: checkoutProblem(error)[1] })))
      }),
    )

  const hosting: ThreadHosting = {
    prepareHost: (row) => checkedOut(row).pipe(Effect.andThen(localPlacement.prepareHost(row))),
    hostIfPrepared: () => Effect.succeedNone,
    connectedHost: localPlacement.connectedHost,
    baseRef: localPlacement.baseRef,
    remove: ({ thread, folder }) =>
      checkoutLock.withLock(
        thread.id,
        fs.remove(folder, { recursive: true, force: true }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Couldn't remove an Agent review's checkout", cause),
          ),
          Effect.mapError(storageFailure),
        ),
      ),
  }

  return {
    hosting,
    brief: (threadId: string) => review(threadId).pipe(Effect.map(({ brief }) => brief)),
    dropCheckout: (row: PlacedThread) =>
      stopOnHost(hosting, row).pipe(Effect.andThen(hosting.remove(row))),
  }
}

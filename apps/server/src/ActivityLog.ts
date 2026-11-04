import {
  Activity,
  type ActivityKind,
  ActivityLogError,
  ActivityPage,
  ActivityStamp,
  LoggedActivity,
  PullRequestRef,
} from "@glass/contracts"
import { Context, DateTime, Effect, Layer, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"
import { GitHubClient } from "./github/GitHubClient"

const encodeActivity = Schema.encodeEffect(Schema.fromJsonString(Activity))

const decodeReferences = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ ref: Schema.fromJsonString(PullRequestRef) })),
)

const decodeStamps = Schema.decodeUnknownEffect(Schema.Array(ActivityStamp))

const decodeLogged = Schema.decodeUnknownEffect(
  Schema.Struct({ ...LoggedActivity.fields, activity: Schema.fromJsonString(Activity) }),
)

export class ActivityLog extends Context.Service<
  ActivityLog,
  {
    readonly record: (activity: Activity) => Effect.Effect<void>
    readonly touchedPullRequests: (
      login: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestRef>, ActivityLogError>
    readonly list: (login: string, limit: number) => Effect.Effect<ActivityPage, ActivityLogError>
    readonly stamps: (
      login: string,
      since: DateTime.Utc,
      kinds: ReadonlyArray<ActivityKind>,
    ) => Effect.Effect<ReadonlyArray<ActivityStamp>, ActivityLogError>
  }
>()("@glass/server/ActivityLog") {
  static readonly layer = Layer.effect(
    ActivityLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const github = yield* GitHubClient

      const record = Effect.fn("ActivityLog.record")(
        function* (activity: Activity) {
          const occurredAt = DateTime.formatIso(yield* DateTime.now)
          const login = (yield* github.knownViewer).login
          const payload = yield* encodeActivity(activity)

          yield* sql`INSERT INTO activity ${sql.insert({
            kind: activity._tag,
            payload,
            occurred_at: occurredAt,
            login,
          })}`
        },
        Effect.catch((cause) => Effect.logWarning("Couldn't record an Activity", cause)),
      )

      const touchedPullRequests = Effect.fn("ActivityLog.touchedPullRequests")(
        function* (viewer: string) {
          const rows = yield* sql`
            SELECT DISTINCT json_extract(payload, '$.pullRequest.ref') AS ref
            FROM activity
            WHERE lower(login) = lower(${viewer})
              AND json_extract(payload, '$.pullRequest.ref') IS NOT NULL
          `

          const references = yield* decodeReferences(rows)

          return references.map(({ ref }) => ref)
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't read the touched PRs", cause)),
        Effect.mapError(
          () =>
            new ActivityLogError({
              message: "Couldn't load the PRs you've touched in Glass. Try again.",
            }),
        ),
      )

      const list = Effect.fn("ActivityLog.list")(
        function* (viewer: string, limit: number) {
          const rows = yield* sql`
            SELECT id, occurred_at AS occurredAt, payload AS activity
            FROM activity
            WHERE lower(login) = lower(${viewer})
            ORDER BY id DESC
            LIMIT ${limit + 1}
          `

          const logged = yield* Effect.forEach(rows.slice(0, limit), (row) =>
            decodeLogged(row).pipe(
              Effect.map((decoded) => Option.some(new LoggedActivity(decoded))),
              Effect.catch((cause) =>
                Effect.logWarning("Skipped an unreadable Activity", cause).pipe(
                  Effect.as(Option.none()),
                ),
              ),
            ),
          )

          return new ActivityPage({
            activities: logged.flatMap(Option.toArray),
            hasMore: rows.length > limit,
          })
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't read the Activity log", cause)),
        Effect.mapError(
          () => new ActivityLogError({ message: "Couldn't load your Activity log. Try again." }),
        ),
      )

      const stamps = Effect.fn("ActivityLog.stamps")(
        function* (viewer: string, since: DateTime.Utc, kinds: ReadonlyArray<ActivityKind>) {
          const rows = yield* sql`
            SELECT kind, occurred_at AS occurredAt
            FROM activity
            WHERE lower(login) = lower(${viewer})
              AND occurred_at >= ${DateTime.formatIso(since)}
              AND kind IN ${sql.in(kinds)}
          `

          return yield* decodeStamps(rows)
        },
        Effect.tapError((cause) => Effect.logWarning("Couldn't read the Activity stamps", cause)),
        Effect.mapError(
          () => new ActivityLogError({ message: "Couldn't load your Activity. Try again." }),
        ),
      )

      return ActivityLog.of({ record, touchedPullRequests, list, stamps })
    }),
  )
}

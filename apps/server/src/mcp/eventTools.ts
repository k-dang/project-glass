import { EventPage, PullRequestRef } from "@glass/contracts"
import { Effect, Option, Schema, Stream } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { EventLog } from "../EventLog"
import { Subscriptions } from "../Subscriptions"
import { ThreadPullRequests } from "../ThreadPullRequests"
import { Threads } from "../Threads"
import { GlassToolFailure, readOnly } from "./glassTools"

const MAX_EVENTS = 100

const ListRecentEvents = Tool.make("list_recent_events", {
  description:
    "Lists recent Events, newest first: what happened to PRs in the user's followed repositories that the user didn't do in Glass, such as a PR's checks failing or passing, review feedback waiting, changes requested, a merge conflict appearing or clearing, and a Thread's PR or a PR with a Subscription merging or closing. Glass keeps Events for 30 days.",
  parameters: Schema.Struct({
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EVENTS })).annotate({
      description: `How many Events to list, at most ${MAX_EVENTS}.`,
    }),
    pullRequest: Schema.optional(
      PullRequestRef.annotate({ description: "List only this PR's Events." }),
    ),
    threadId: Schema.optional(
      Schema.String.annotate({
        description:
          "List only the Events of this Thread's PR and of every PR it has a Subscription to. The Thread's id, from list_threads.",
      }),
    ),
    since: Schema.optional(
      Schema.DateTimeUtcFromString.annotate({
        description: "List only Events from this time on, as an ISO 8601 time.",
      }),
    ),
  }),
  success: EventPage,
  failure: GlassToolFailure,
}).annotateMerge(readOnly)

export const EventTools = Toolkit.make(ListRecentEvents)

export const EventToolHandlers = EventTools.toLayer(
  Effect.gen(function* () {
    const eventLog = yield* EventLog
    const threads = yield* Threads
    const threadPullRequests = yield* ThreadPullRequests
    const subscriptions = yield* Subscriptions

    const pullRequestsOf = Effect.fnUntraced(function* (threadId: string) {
      yield* threads.placeOf(threadId).pipe(
        Effect.mapError(
          () =>
            new GlassToolFailure({
              message: "There's no Thread with that id. list_threads names the Threads there are.",
            }),
        ),
      )

      const listed = yield* threadPullRequests.watch().pipe(Stream.runHead)
      const own = Option.getOrThrow(listed).find((pr) => pr.threadId === threadId)?.ref

      const subscribed = yield* subscriptions
        .list(threadId)
        .pipe(Effect.mapError(({ message }) => new GlassToolFailure({ message })))

      return [
        ...(own === undefined ? [] : [own]),
        ...subscribed.flatMap(({ pullRequest }) => (pullRequest === null ? [] : [pullRequest])),
      ]
    })

    return EventTools.of({
      list_recent_events: ({ limit, pullRequest, threadId, since }) =>
        Effect.gen(function* () {
          if (threadId === undefined)
            return yield* eventLog.list({
              limit,
              pullRequests: pullRequest === undefined ? undefined : [pullRequest],
              since,
            })

          if (pullRequest !== undefined)
            return yield* new GlassToolFailure({
              message: "Pass pullRequest or threadId, not both.",
            })

          const pullRequests = yield* pullRequestsOf(threadId)

          return pullRequests.length === 0
            ? new EventPage({ events: [], hasMore: false })
            : yield* eventLog.list({ limit, pullRequests, since })
        }).pipe(
          Effect.catchTag("EventLogError", ({ message }) =>
            Effect.fail(new GlassToolFailure({ message })),
          ),
        ),
    })
  }),
)

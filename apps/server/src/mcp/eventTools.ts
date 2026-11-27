import { EventPage, PullRequestRef, referenceKey } from "@glass/contracts"
import { Duration, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/ai"
import { EventLog, KEPT_FOR } from "../EventLog"
import { GlassToolFailure, readOnly } from "./glassTools"

const MAX_EVENTS = 100

const ListRecentEvents = Tool.make("list_recent_events", {
  description: `Lists recent Events, newest first: what happened to the subjects of Subscriptions that the user didn't do in Glass, such as a PR's checks failing or passing, review feedback waiting, changes requested, a merge conflict appearing or clearing, and the PR merging or closing. Glass keeps Events for ${Duration.toDays(KEPT_FOR)} days.`,
  parameters: Schema.Struct({
    limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_EVENTS })).annotate({
      description: `How many Events to list, at most ${MAX_EVENTS}.`,
    }),
    pullRequest: Schema.optional(
      PullRequestRef.annotate({ description: "List only this PR's Events." }),
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

    return EventTools.of({
      list_recent_events: ({ limit, pullRequest, since }) =>
        eventLog
          .list({
            limit,
            about:
              pullRequest === undefined
                ? undefined
                : { source: "github", subjects: [referenceKey(pullRequest)] },
            since,
          })
          .pipe(Effect.mapError(({ message }) => new GlassToolFailure({ message }))),
    })
  }),
)

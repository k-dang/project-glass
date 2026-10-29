import { Schema } from "effect"
import { AgentEngine, PlaceTag } from "./agent"
import { Draft } from "./draft"
import { FollowedRepository } from "./followedRepository"
import { PullRequestRef } from "./pullRequest"
import { ReviewDecision } from "./review"
import { Revision } from "./revision"

export class ActivityLogError extends Schema.TaggedError<ActivityLogError>()("ActivityLogError", {
  message: Schema.String,
}) {}

export class ActivityPullRequest extends Schema.Class<ActivityPullRequest>("ActivityPullRequest")({
  ref: PullRequestRef,
  title: Schema.String,
  revision: Revision,
}) {}

export class ActivityToDo extends Schema.Class<ActivityToDo>("ActivityToDo")({
  id: Schema.Int,
  title: Schema.String,
}) {}

export const PullRequestOpened = Schema.TaggedStruct("PullRequestOpened", {
  pullRequest: ActivityPullRequest,
})

export const FileViewed = Schema.TaggedStruct("FileViewed", {
  pullRequest: ActivityPullRequest,
  path: Schema.String,
})

export const ReviewSubmitted = Schema.TaggedStruct("ReviewSubmitted", {
  pullRequest: ActivityPullRequest,
  decision: ReviewDecision,
  summary: Schema.String,
  drafts: Schema.Array(Draft),
})

export const ReplySent = Schema.TaggedStruct("ReplySent", {
  pullRequest: ActivityPullRequest,
  discussionId: Schema.String,
  body: Schema.String,
})

export const ToDoAdded = Schema.TaggedStruct("ToDoAdded", { toDo: ActivityToDo })

export const ToDoDone = Schema.TaggedStruct("ToDoDone", { toDo: ActivityToDo })

export const AgentStarted = Schema.TaggedStruct("AgentStarted", {
  agentId: Schema.String,
  name: Schema.String,
  repository: FollowedRepository,
  machine: PlaceTag,
  engine: AgentEngine,
  message: Schema.String,
})

export const Activity = Schema.Union([
  PullRequestOpened,
  FileViewed,
  ReviewSubmitted,
  ReplySent,
  ToDoAdded,
  ToDoDone,
  AgentStarted,
])

export type Activity = typeof Activity.Type

export class LoggedActivity extends Schema.Class<LoggedActivity>("LoggedActivity")({
  id: Schema.Int,
  occurredAt: Schema.DateTimeUtcFromString,
  activity: Activity,
}) {}

export class ActivityPage extends Schema.Class<ActivityPage>("ActivityPage")({
  activities: Schema.Array(LoggedActivity),
  hasMore: Schema.Boolean,
}) {}

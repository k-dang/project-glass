import { Schema } from "effect"
import { GitHubUnavailable } from "./connection"
import { PullRequestRef, PullRequestState } from "./pullRequest"
import { PullRequestSummary } from "./pullRequestList"
import { Revision } from "./revision"

export class QueuedPullRequest extends Schema.Class<QueuedPullRequest>("QueuedPullRequest")({
  id: Schema.String,
  queuedAt: Schema.DateTimeUtcFromString,
  pullRequest: PullRequestSummary,
  state: PullRequestState,
  /** As GitHub last answered; null for a PR queued before Glass kept it, until it refreshes. */
  revision: Schema.NullOr(Revision),
  openedSinceQueued: Schema.Boolean,
  problem: Schema.NullOr(GitHubUnavailable),
}) {}

export const Queue = Schema.Array(QueuedPullRequest)

export type Queue = typeof Queue.Type

export class QueueAddition extends Schema.Class<QueueAddition>("QueueAddition")({
  added: Schema.Array(PullRequestRef),
  alreadyQueued: Schema.Array(PullRequestRef),
  notFound: Schema.Array(PullRequestRef),
}) {}

export class QueueError extends Schema.TaggedError<QueueError>()("QueueError", {
  message: Schema.String,
}) {}

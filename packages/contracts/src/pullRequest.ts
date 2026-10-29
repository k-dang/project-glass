import { Schema } from "effect"
import { ConnectionError } from "./connection"
import { Discussions } from "./discussion"
import { Draft } from "./draft"
import { Revision } from "./revision"

export class PullRequestRef extends Schema.Class<PullRequestRef>("PullRequestRef")({
  owner: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]+$/)),
  repo: Schema.String.check(Schema.isPattern(/^[\w.-]+$/)),
  // GitHub's GraphQL Int is signed 32-bit.
  number: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(2 ** 31 - 1)),
}) {}

/** GitHub matches owner and repository names ignoring case, so this identifies one PR. */
export const referenceKey = ({ owner, repo, number }: PullRequestRef) =>
  `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`

export const PullRequestState = Schema.Literals(["draft", "open", "closed", "merged"])

export type PullRequestState = typeof PullRequestState.Type

/** Whether the PR's Reviews satisfy its repository's rules, or null when the rules require none. */
export const Approval = Schema.Literals(["approved", "changes-requested", "review-required"])

export type Approval = typeof Approval.Type

export const ReviewerState = Schema.Literals(["approved", "changes-requested", "requested"])

export type ReviewerState = typeof ReviewerState.Type

export class Reviewer extends Schema.Class<Reviewer>("Reviewer")({
  name: Schema.String,
  state: ReviewerState,
}) {}

export const CheckState = Schema.Literals(["passed", "failed", "running", "skipped"])

export type CheckState = typeof CheckState.Type

export class Check extends Schema.Class<Check>("Check")({
  name: Schema.String,
  state: CheckState,
  url: Schema.NullOr(Schema.String),
}) {}

export const Mergeable = Schema.Literals(["mergeable", "conflicting", "checking"])

export type Mergeable = typeof Mergeable.Type

export class PullRequest extends Schema.Class<PullRequest>("PullRequest")({
  id: Schema.String,
  ref: PullRequestRef,
  url: Schema.String,
  title: Schema.String,
  author: Schema.String,
  baseBranch: Schema.String,
  headBranch: Schema.String,
  state: PullRequestState,
  descriptionHtml: Schema.String,
  viewerIsAuthor: Schema.Boolean,
  approval: Schema.NullOr(Approval),
  reviewers: Schema.Array(Reviewer),
  checks: Schema.Array(Check),
  mergeable: Mergeable,
}) {}

export const ChangeType = Schema.Literals(["added", "modified", "deleted", "renamed"])

export type ChangeType = typeof ChangeType.Type

export const TextPatch = Schema.TaggedStruct("TextPatch", { hunks: Schema.String })

export const BinaryFile = Schema.TaggedStruct("BinaryFile", {})

export const PatchTooLarge = Schema.TaggedStruct("PatchTooLarge", {})

export const EmptyFile = Schema.TaggedStruct("EmptyFile", {})

export const NoTextChanges = Schema.TaggedStruct("NoTextChanges", {})

export const FilePatch = Schema.Union([
  TextPatch,
  BinaryFile,
  PatchTooLarge,
  EmptyFile,
  NoTextChanges,
])

export type FilePatch = typeof FilePatch.Type

export class ChangedFile extends Schema.Class<ChangedFile>("ChangedFile")({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  changeType: ChangeType,
  additions: Schema.Int,
  deletions: Schema.Int,
  patch: FilePatch,
}) {}

/** The GitHub user Glass acts as, who writes the workspace's Drafts. */
export class Viewer extends Schema.Class<Viewer>("Viewer")({
  login: Schema.String,
  avatarUrl: Schema.String,
}) {}

export class PullRequestWorkspace extends Schema.Class<PullRequestWorkspace>(
  "PullRequestWorkspace",
)({
  viewer: Viewer,
  pullRequest: PullRequest,
  revision: Revision,
  updatedAt: Schema.DateTimeUtcFromString,
  files: Schema.Array(ChangedFile),
  viewedPaths: Schema.Array(Schema.String),
  discussions: Discussions,
  drafts: Schema.Array(Draft),
}) {}

/** GitHub returns the same not-found response for nonexistent and inaccessible private repositories. */
export class PullRequestNotFound extends Schema.TaggedError<PullRequestNotFound>()(
  "PullRequestNotFound",
  { ref: PullRequestRef },
) {}

export class PullRequestAccessDenied extends Schema.TaggedError<PullRequestAccessDenied>()(
  "PullRequestAccessDenied",
  { ref: PullRequestRef, message: Schema.String },
) {}

export const OpenPullRequestError = Schema.Union([
  PullRequestNotFound,
  PullRequestAccessDenied,
  ConnectionError,
])

export type OpenPullRequestError = typeof OpenPullRequestError.Type

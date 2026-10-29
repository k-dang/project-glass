import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Activity, ActivityLogError, ActivityPage } from "./activity"
import { AgentReviewFailure, AgentReviewState, ReviewPrompt } from "./agentReview"
import { AskAnswer, AskFailure, AskPlace, AskQuestion } from "./ask"
import {
  Agent,
  AgentBusy,
  AgentEngine,
  AgentError,
  AgentModels,
  AgentPlace,
  AgentNotFound,
  Branches,
  InvalidLocalCheckout,
  LocalCheckout,
  MessageInput,
  ModelChoice,
  NewAgent,
  NoPermissionModes,
  PermissionMode,
  RemovalWarnings,
  RequestAnswer,
  RequestNotWaiting,
  RequestWaiting,
  SandboxProviderInfo,
  SentMessage,
  TranscriptUpdate,
} from "./agent"
import { ConnectionError, GitHubConnection } from "./connection"
import { DiffSide, DiscussionResolutionError, PublishedComment, ReplyError } from "./discussion"
import { CreateDraftError, Draft, UpdateDraftError } from "./draft"
import { EngineFeature, EngineSettings } from "./engine"
import { FollowedRepository, InvalidRepositoryInput } from "./followedRepository"
import {
  ChangedFile,
  OpenPullRequestError,
  PullRequestRef,
  PullRequestWorkspace,
} from "./pullRequest"
import { PullRequestListings } from "./pullRequestList"
import { Queue, QueueAddition, QueueError, QueuedPullRequest } from "./queue"
import { FileContents, GetFileContentsError, RepositoryFiles } from "./repository"
import { ReviewDecision, SubmitReviewError } from "./review"
import { Revision, RevisionSide, StaleRevision } from "./revision"
import { ResumableDestination, SavedPlace, SavedPlaceError } from "./savedPlace"
import { SettingsError } from "./settings"
import { ToDo, ToDoError, ToDoTitle } from "./toDo"
import { TourFailure, TourState } from "./tour"

export const RPC_PATH = "/rpc"

export const TOKEN_PARAM = "token"

export const NewDraft = Schema.Struct({
  pullRequestId: Schema.String,
  revision: Revision,
  path: Schema.String,
  side: DiffSide,
  line: Schema.Int,
  body: Schema.NonEmptyString,
})

export type NewDraft = typeof NewDraft.Type

const toDoList = { success: Schema.Array(ToDo), error: ToDoError }

export class GlassRpcs extends RpcGroup.make(
  Rpc.make("GetSavedPlace", { success: Schema.NullOr(SavedPlace), error: SavedPlaceError }),
  Rpc.make("SavePlace", {
    payload: { destination: ResumableDestination },
    success: SavedPlace,
    error: SavedPlaceError,
  }),
  /** Writes with the Tour engine. */
  Rpc.make("WriteTour", {
    payload: { pullRequest: PullRequestRef, revision: Revision },
    error: TourFailure,
  }),
  Rpc.make("CancelTour", { payload: { pullRequest: PullRequestRef }, error: TourFailure }),
  Rpc.make("WatchTour", {
    payload: { pullRequest: PullRequestRef },
    success: TourState,
    error: TourFailure,
    stream: true,
  }),
  /** Starting again cancels a running Agent review; the finished one replaces the last. */
  Rpc.make("StartAgentReview", {
    payload: { pullRequest: PullRequestRef, revision: Revision },
    error: AgentReviewFailure,
  }),
  Rpc.make("CancelAgentReview", {
    payload: { pullRequest: PullRequestRef },
    error: AgentReviewFailure,
  }),
  Rpc.make("WatchAgentReview", {
    payload: { pullRequest: PullRequestRef },
    success: AgentReviewState,
    error: AgentReviewFailure,
    stream: true,
  }),
  /** Answers privately, saving nothing; interrupting the call cancels the agent. */
  Rpc.make("Ask", {
    payload: {
      pullRequest: PullRequestRef,
      revision: Revision,
      place: AskPlace,
      question: AskQuestion,
    },
    success: AskAnswer,
    error: AskFailure,
  }),
  Rpc.make("GetReviewPrompt", { success: ReviewPrompt, error: SettingsError }),
  Rpc.make("SetReviewPrompt", {
    payload: { prompt: ReviewPrompt },
    success: ReviewPrompt,
    error: SettingsError,
  }),
  Rpc.make("GetEngineSettings", {
    payload: { feature: EngineFeature },
    success: EngineSettings,
    error: SettingsError,
  }),
  Rpc.make("SetEngineSettings", {
    payload: { feature: EngineFeature, engineSettings: EngineSettings },
    success: EngineSettings,
    error: SettingsError,
  }),
  /** Whether Glass writes a Tour for each open PR added to the Queue; off until the user turns it on. */
  Rpc.make("GetQueueTours", { success: Schema.Boolean, error: SettingsError }),
  Rpc.make("SetQueueTours", { payload: { enabled: Schema.Boolean }, error: SettingsError }),
  Rpc.make("ListFollowedRepositories", {
    success: Schema.Array(FollowedRepository),
    error: SettingsError,
  }),
  Rpc.make("FollowRepository", {
    payload: { input: Schema.String },
    success: Schema.Array(FollowedRepository),
    error: Schema.Union([InvalidRepositoryInput, SettingsError]),
  }),
  Rpc.make("UnfollowRepository", {
    payload: { repository: FollowedRepository },
    success: Schema.Array(FollowedRepository),
    error: SettingsError,
  }),
  /** Catches up with GitHub, then lists every PR list. */
  Rpc.make("ListPullRequests", {
    success: PullRequestListings,
    error: Schema.Union([SettingsError, ConnectionError]),
  }),
  /** The PR lists as GitHub last answered, without asking GitHub again; null before any answer. */
  Rpc.make("ListSavedPullRequests", {
    success: Schema.NullOr(PullRequestListings),
    error: SettingsError,
  }),
  Rpc.make("ListSavedQueue", { success: Queue, error: QueueError }),
  Rpc.make("RefreshQueue", { error: Schema.Union([QueueError, ConnectionError]) }),
  Rpc.make("AddToQueue", {
    payload: { references: Schema.Array(PullRequestRef) },
    success: QueueAddition,
    error: Schema.Union([QueueError, ConnectionError]),
  }),
  Rpc.make("RemoveFromQueue", {
    payload: { reference: PullRequestRef },
    success: Schema.NullOr(QueuedPullRequest),
    error: QueueError,
  }),
  Rpc.make("RestoreToQueue", {
    payload: { queued: QueuedPullRequest },
    error: QueueError,
  }),
  Rpc.make("GetConnection", {
    success: GitHubConnection,
    error: ConnectionError,
  }),
  Rpc.make("OpenPullRequest", {
    payload: { pullRequest: PullRequestRef },
    success: PullRequestWorkspace,
    error: OpenPullRequestError,
  }),
  /** Misses changes GitHub makes without touching the PR's updatedAt, like a removed Review request. */
  Rpc.make("HasPullRequestChanged", {
    payload: {
      pullRequestId: Schema.String,
      revision: Revision,
      updatedAt: Schema.DateTimeUtcFromString,
    },
    success: Schema.Boolean,
    error: ConnectionError,
  }),
  Rpc.make("GetFileContents", {
    payload: {
      pullRequest: PullRequestRef,
      revision: Revision,
      side: RevisionSide,
      path: Schema.String,
    },
    success: FileContents,
    error: GetFileContentsError,
  }),
  Rpc.make("ListRepositoryFiles", {
    payload: { pullRequest: PullRequestRef, revision: Revision },
    success: RepositoryFiles,
    error: ConnectionError,
  }),
  Rpc.make("SetFileViewed", {
    payload: {
      pullRequestId: Schema.String,
      revision: Revision,
      path: Schema.String,
      viewed: Schema.Boolean,
    },
    error: Schema.Union([StaleRevision, ConnectionError]),
  }),
  Rpc.make("CreateDraft", {
    payload: NewDraft,
    success: Draft,
    error: CreateDraftError,
  }),
  Rpc.make("UpdateDraft", {
    payload: { id: Schema.String, body: Schema.NonEmptyString },
    error: UpdateDraftError,
  }),
  Rpc.make("DeleteDraft", {
    payload: { id: Schema.String },
    error: ConnectionError,
  }),
  Rpc.make("SubmitReview", {
    payload: {
      pullRequestId: Schema.String,
      revision: Revision,
      decision: ReviewDecision,
      summary: Schema.String,
    },
    error: SubmitReviewError,
  }),
  Rpc.make("ReplyToDiscussion", {
    payload: { discussionId: Schema.String, body: Schema.NonEmptyString },
    success: PublishedComment,
    error: ReplyError,
  }),
  Rpc.make("SetDiscussionResolved", {
    payload: { discussionId: Schema.String, resolved: Schema.Boolean },
    success: Schema.Boolean,
    error: DiscussionResolutionError,
  }),
  Rpc.make("RecordActivity", { payload: Activity }),
  Rpc.make("ListActivity", {
    payload: { limit: Schema.Int.check(Schema.isGreaterThan(0)) },
    success: ActivityPage,
    error: Schema.Union([ConnectionError, ActivityLogError]),
  }),
  Rpc.make("ListToDos", toDoList),
  Rpc.make("AddToDo", { payload: { title: ToDoTitle }, ...toDoList }),
  Rpc.make("EditToDo", {
    payload: { id: Schema.Int, title: ToDoTitle, notes: Schema.String },
    ...toDoList,
  }),
  Rpc.make("SetToDoDone", { payload: { id: Schema.Int, done: Schema.Boolean }, ...toDoList }),
  Rpc.make("DeleteToDo", { payload: { id: Schema.Int }, ...toDoList }),
  /** The Agents list, again after every change to it. */
  Rpc.make("WatchAgents", { success: Schema.Array(Agent), error: AgentError, stream: true }),
  /** The ids of the Agents with a Permission request or Question waiting, again after every change. */
  Rpc.make("WatchWaitingAgents", {
    success: Schema.Array(Schema.String),
    error: AgentError,
    stream: true,
  }),
  /** One Agent's transcript as a snapshot, then each event after it. */
  Rpc.make("WatchTranscript", {
    payload: { agentId: Schema.String },
    success: TranscriptUpdate,
    error: Schema.Union([AgentNotFound, AgentError]),
    stream: true,
  }),
  Rpc.make("ListLocalCheckouts", { success: Schema.Array(LocalCheckout), error: AgentError }),
  Rpc.make("LinkLocalCheckout", {
    payload: { path: Schema.String },
    success: LocalCheckout,
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  Rpc.make("ListBranches", {
    payload: { repository: FollowedRepository },
    success: Branches,
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  Rpc.make("ListGitHubBranches", {
    payload: { repository: FollowedRepository },
    success: Branches,
    error: ConnectionError,
  }),
  Rpc.make("ListAgentModels", {
    payload: { engine: AgentEngine, place: AgentPlace },
    success: AgentModels,
    error: AgentError,
  }),
  Rpc.make("ListSandboxProviders", { success: Schema.Array(SandboxProviderInfo) }),
  Rpc.make("CreateAgent", {
    payload: NewAgent,
    success: Agent,
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  /** Starts a Turn, or while one runs, Queues the message. */
  Rpc.make("SendMessage", {
    payload: { agentId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([AgentNotFound, RequestWaiting, AgentError]),
  }),
  /** Sends the message into the running Turn, or as SendMessage does when it can't. */
  Rpc.make("Steer", {
    payload: { agentId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([AgentNotFound, RequestWaiting, AgentError]),
  }),
  Rpc.make("CancelQueuedMessage", {
    payload: { agentId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  /** Starts a Queued message's Turn now. */
  Rpc.make("SendQueuedMessage", {
    payload: { agentId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentBusy, AgentError]),
  }),
  /** Ends the running Turn as stopped and leaves the Queued messages waiting. */
  Rpc.make("StopTurn", {
    payload: { agentId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("GetUnsentMessage", {
    payload: { agentId: Schema.String },
    success: SentMessage,
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("SaveUnsentMessage", {
    payload: { agentId: Schema.String, ...SentMessage.fields },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  /** Applies from the Agent's next Turn. */
  Rpc.make("ChangeAgentModel", {
    payload: { agentId: Schema.String, ...ModelChoice.fields },
    success: Agent,
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  /** Applies from the Agent's next Turn. */
  Rpc.make("ChangePermissionMode", {
    payload: { agentId: Schema.String, permissionMode: PermissionMode },
    success: Agent,
    error: Schema.Union([AgentNotFound, NoPermissionModes, AgentError]),
  }),
  Rpc.make("AnswerRequest", {
    payload: { agentId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([AgentNotFound, RequestNotWaiting, AgentError]),
  }),
  Rpc.make("GetRemovalWarnings", {
    payload: { agentId: Schema.String },
    success: RemovalWarnings,
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  /** The Agent's changes since its base branch, uncommitted work included. */
  Rpc.make("GetAgentChanges", {
    payload: { agentId: Schema.String },
    success: Schema.Array(ChangedFile),
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  /** Stops the Agent, removes its worktree and transcript, and keeps its branch. */
  Rpc.make("RemoveAgent", {
    payload: { agentId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
) {}

export type GlassRpcError = Rpc.Error<RpcGroup.Rpcs<typeof GlassRpcs>>

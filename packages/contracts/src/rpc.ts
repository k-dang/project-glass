import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Activity, ActivityKind, ActivityLogError, ActivityPage, ActivityStamp } from "./activity"
import { AgentReviewFailure, AgentReviewState, FollowUpMessage, ReviewPrompt } from "./agentReview"
import { AskAnswer, AskFailure, AskPlace, AskQuestion } from "./ask"
import {
  Agent,
  AgentBusy,
  AgentChanges,
  AgentCommand,
  AgentEngine,
  AgentError,
  AgentModels,
  AgentPlace,
  AgentNotFound,
  InvalidLocalCheckout,
  LocalCheckout,
  MessageInput,
  MessageInputWithContext,
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
import {
  DiffSide,
  DiscussionResolutionError,
  PublishedComment,
  Reaction,
  ReactionError,
  ReactionGroup,
  ReplyError,
} from "./discussion"
import { CreateDraftError, Draft, UpdateDraftError } from "./draft"
import { EngineFeature, EngineSettings } from "./engine"
import { FeedbackNote } from "./feedbackNote"
import { FollowedRepository, InvalidRepositoryInput } from "./followedRepository"
import { OpenPullRequestError, PullRequestRef, PullRequestWorkspace } from "./pullRequest"
import { PullRequestListings } from "./pullRequestList"
import { Queue, QueueAddition, QueueError, QueuedPullRequest } from "./queue"
import { FileContents, GetFileContentsError, RepositoryFiles } from "./repository"
import { ReviewDecision, SubmitReviewError } from "./review"
import { Revision, RevisionSide, StaleRevision } from "./revision"
import { ResumableDestination, SavedPlace, SavedPlaceError } from "./savedPlace"
import { SettingsError } from "./settings"
import { StorageError, StorageItem } from "./storage"
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
  Rpc.make("GetSavedPlaces", { success: Schema.Array(SavedPlace), error: SavedPlaceError }),
  Rpc.make("SavePlace", {
    payload: { destination: ResumableDestination },
    success: SavedPlace,
    error: SavedPlaceError,
  }),
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
  Rpc.make("StartAgentReview", {
    payload: { pullRequest: PullRequestRef, revision: Revision },
    error: AgentReviewFailure,
  }),
  Rpc.make("FollowUpAgentReview", {
    payload: { pullRequest: PullRequestRef, revision: Revision, message: FollowUpMessage },
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
  Rpc.make("GetQueueWork", {
    payload: { feature: EngineFeature },
    success: Schema.Boolean,
    error: SettingsError,
  }),
  Rpc.make("SetQueueWork", {
    payload: { feature: EngineFeature, enabled: Schema.Boolean },
    error: SettingsError,
  }),
  Rpc.make("GetStorageBreakdown", { success: Schema.Array(StorageItem), error: StorageError }),
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
  Rpc.make("ListPullRequests", {
    success: PullRequestListings,
    error: Schema.Union([SettingsError, ConnectionError]),
  }),
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
  Rpc.make("SetReaction", {
    payload: { commentId: Schema.String, reaction: Reaction, reacted: Schema.Boolean },
    success: Schema.Array(ReactionGroup),
    error: ReactionError,
  }),
  Rpc.make("RecordActivity", { payload: Activity }),
  Rpc.make("ListActivity", {
    payload: { limit: Schema.Int.check(Schema.isGreaterThan(0)) },
    success: ActivityPage,
    error: Schema.Union([ConnectionError, ActivityLogError]),
  }),
  Rpc.make("ListActivityStamps", {
    payload: { since: Schema.DateTimeUtcFromString, kinds: Schema.NonEmptyArray(ActivityKind) },
    success: Schema.Array(ActivityStamp),
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
  Rpc.make("WatchAgents", { success: Schema.Array(Agent), error: AgentError, stream: true }),
  Rpc.make("WatchWaitingAgents", {
    success: Schema.Array(Schema.String),
    error: AgentError,
    stream: true,
  }),
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
  Rpc.make("GetNewAgentDefaultBranch", {
    payload: { place: AgentPlace, repository: FollowedRepository },
    success: Schema.NullOr(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, AgentError]),
  }),
  Rpc.make("ListNewAgentBranches", {
    payload: { place: AgentPlace, repository: FollowedRepository },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, AgentError]),
  }),
  Rpc.make("ListAgentModels", {
    payload: { engine: AgentEngine, place: AgentPlace },
    success: AgentModels,
    error: AgentError,
  }),
  Rpc.make("ListNewAgentCommands", {
    payload: { engine: AgentEngine, place: AgentPlace, repository: FollowedRepository },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  Rpc.make("ListAgentCommands", {
    payload: { agentId: Schema.String },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("ListNewAgentFiles", {
    payload: { place: AgentPlace, repository: FollowedRepository, baseBranch: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  Rpc.make("ListAgentFiles", {
    payload: { agentId: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("ListSandboxProviders", { success: Schema.Array(SandboxProviderInfo) }),
  Rpc.make("CreateAgent", {
    payload: NewAgent,
    success: Agent,
    error: Schema.Union([InvalidLocalCheckout, AgentError]),
  }),
  Rpc.make("SendMessage", {
    payload: { agentId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([AgentNotFound, RequestWaiting, AgentError]),
  }),
  Rpc.make("Steer", {
    payload: { agentId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([AgentNotFound, RequestWaiting, AgentError]),
  }),
  Rpc.make("CancelQueuedMessage", {
    payload: { agentId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("SendQueuedMessage", {
    payload: { agentId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentBusy, AgentError]),
  }),
  Rpc.make("StopTurn", {
    payload: { agentId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("ReachSandbox", {
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
  Rpc.make("ChangeAgentModel", {
    payload: { agentId: Schema.String, ...ModelChoice.fields },
    success: Agent,
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
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
  Rpc.make("GetAgentChanges", {
    payload: { agentId: Schema.String },
    success: AgentChanges,
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("ListFeedbackNotes", {
    payload: { agentId: Schema.String },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("SaveFeedbackNote", {
    payload: { agentId: Schema.String, note: FeedbackNote },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("RemoveFeedbackNote", {
    payload: { agentId: Schema.String, noteId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("RemoveAgent", {
    payload: { agentId: Schema.String },
    error: Schema.Union([AgentNotFound, AgentError]),
  }),
  Rpc.make("GetGlobalConversationModel", {
    success: ModelChoice,
    error: AgentError,
  }),
  Rpc.make("ChangeGlobalConversationModel", {
    payload: ModelChoice.fields,
    error: AgentError,
  }),
  Rpc.make("WatchGlobalTranscript", { success: TranscriptUpdate, error: AgentError, stream: true }),
  Rpc.make("SendGlobalMessage", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, AgentError]),
  }),
  Rpc.make("SteerGlobal", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, AgentError]),
  }),
  Rpc.make("CancelGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: AgentError,
  }),
  Rpc.make("SendGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: Schema.Union([AgentBusy, AgentError]),
  }),
  Rpc.make("StopGlobalTurn", { error: AgentError }),
  Rpc.make("AnswerGlobalRequest", {
    payload: { requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, AgentError]),
  }),
  Rpc.make("GetGlobalUnsentMessage", { success: SentMessage, error: AgentError }),
  Rpc.make("SaveGlobalUnsentMessage", { payload: SentMessage, error: AgentError }),
) {}

export type GlassRpcError = Rpc.Error<RpcGroup.Rpcs<typeof GlassRpcs>>

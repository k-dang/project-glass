import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Activity, ActivityKind, ActivityLogError, ActivityPage, ActivityStamp } from "./activity"
import {
  AgentReviewDone,
  AgentReviewFailure,
  AgentReviewState,
  FollowUpMessage,
  ReviewPrompt,
} from "./agentReview"
import { AskAnswer, AskFailure, AskPlace, AskQuestion } from "./ask"
import {
  Thread,
  ThreadBusy,
  ThreadChanges,
  AgentCommand,
  AgentHarness,
  ThreadError,
  AgentModels,
  ThreadPlace,
  ThreadNotFound,
  EndedGlobalChatSession,
  GlobalChatSessionNotFound,
  Image,
  InvalidLocalCheckout,
  LocalCheckout,
  MessageInput,
  MessageInputWithContext,
  ModelChoice,
  NewThread,
  NoPermissionModes,
  PermissionMode,
  QueuedMessageStarted,
  RemovalWarnings,
  RequestAnswer,
  RequestNotWaiting,
  RequestWaiting,
  SandboxProviderInfo,
  SendThreadMessage,
  SentMessage,
  StartFreshRefused,
  TranscriptUpdate,
  TurnEnd,
  ThreadFile,
  NamedPaths,
} from "./thread"
import { ConnectionError, GitHubConnection } from "./connection"
import {
  DiffSide,
  ReviewThreadResolutionError,
  PublishedComment,
  Reaction,
  ReactionError,
  ReactionGroup,
  ReplyError,
} from "./comment"
import { CreateDraftError, Draft, UpdateDraftError } from "./draft"
import { EngineFeature, EngineSettings } from "./engine"
import { FeedbackNote, LineNote } from "./feedbackNote"
import { BrowserControl, BrowserPageAnswer, BrowserPageRequest } from "./browserPage"
import { CheckInAnswer, CheckInChanges, CheckInError, CheckInNotWaiting } from "./checkIn"
import { FollowedRepository, InvalidRepositoryInput } from "./followedRepository"
import { MergeAction, MergePullRequestError } from "./merge"
import {
  InboxItems,
  OutsideQuestionAnswer,
  OutsideQuestionNotWaiting,
  TurnSeen,
  UnseenTurn,
} from "./inbox"
import {
  OutsideAgent,
  OutsideAgentDecision,
  OutsideAgentNotFound,
  OutsideAgentRequestNotWaiting,
} from "./outsideAgent"
import {
  LoadPullRequestError,
  PullRequestRef,
  PullRequestStatus,
  PullRequestWorkspace,
} from "./pullRequest"
import {
  ThreadPullRequest,
  LatestPullRequestListings,
  PullRequestListings,
} from "./pullRequestList"
import { PullRequestUpdateNote } from "./pullRequestUpdate"
import { Queue, QueueAddition, QueueError, QueuedPullRequest } from "./queue"
import { FileContents, GetFileContentsError, RepositoryFiles } from "./repository"
import { ReviewDecision, SubmitReviewError } from "./review"
import { Revision, RevisionSide, StaleRevision } from "./revision"
import { ResumableDestination, SavedPlace, SavedPlaceError } from "./savedPlace"
import { SettingsError } from "./settings"
import {
  InvalidSkillPackName,
  InvalidSkillPackUrl,
  LocalSkillsError,
  SkillPack,
  SkillPackError,
  SkillPackNameTaken,
  SkillPackNotFound,
  SkillPackNotReadable,
  SkillPackPreview,
  SkillPackSource,
  SkillPackUpdate,
} from "./skillPack"
import { StorageError, StorageItem } from "./storage"
import { Subscription } from "./subscription"
import { ToDo, ToDoError, ToDoImageSize, ToDoImageUploads, ToDoTitle } from "./toDo"
import { TourFailure, TourState } from "./tour"

export const RPC_PATH = "/rpc"

export const THREAD_FILES_PATH = "/thread-files"

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

const skillPackList = { success: Schema.Array(SkillPack), error: SkillPackError }

const SkillPackReadError = Schema.Union([SkillPackNotReadable, SkillPackError, ConnectionError])

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
  Rpc.make("MarkAgentReviewDone", {
    payload: AgentReviewDone,
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
  Rpc.make("GetPullRequestUpdateNote", { success: PullRequestUpdateNote, error: SettingsError }),
  Rpc.make("SetPullRequestUpdateNote", {
    payload: { note: PullRequestUpdateNote },
    success: PullRequestUpdateNote,
    error: SettingsError,
  }),
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
  Rpc.make("ListSkillPacks", skillPackList),
  Rpc.make("PreviewSkillPack", {
    payload: { url: Schema.String },
    success: SkillPackPreview,
    error: Schema.Union([InvalidSkillPackUrl, SkillPackReadError]),
  }),
  Rpc.make("AddSkillPack", {
    payload: { source: SkillPackSource, commit: Schema.String, name: Schema.String },
    success: Schema.Array(SkillPack),
    error: Schema.Union([InvalidSkillPackName, SkillPackNameTaken, SkillPackReadError]),
  }),
  Rpc.make("PreviewSkillPackUpdate", {
    payload: { name: Schema.String },
    success: SkillPackUpdate,
    error: Schema.Union([SkillPackNotFound, SkillPackReadError]),
  }),
  Rpc.make("UpdateSkillPack", {
    payload: { name: Schema.String, commit: Schema.String },
    success: Schema.Array(SkillPack),
    error: Schema.Union([SkillPackNotFound, SkillPackReadError]),
  }),
  Rpc.make("RemoveSkillPack", { payload: { name: Schema.String }, ...skillPackList }),
  Rpc.make("ListLocalSkills", {
    payload: { harness: AgentHarness },
    success: Schema.Array(Schema.String),
    error: LocalSkillsError,
  }),
  Rpc.make("ListPullRequests", {
    success: PullRequestListings,
    error: Schema.Union([SettingsError, ConnectionError]),
  }),
  Rpc.make("WatchPullRequests", { success: LatestPullRequestListings, stream: true }),
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
  Rpc.make("LoadPullRequest", {
    payload: { pullRequest: PullRequestRef },
    success: PullRequestWorkspace,
    error: LoadPullRequestError,
  }),
  // WARNING: Misses changes GitHub makes without touching the PR's updatedAt, such as a removed Review request.
  Rpc.make("HasPullRequestChanged", {
    payload: {
      pullRequestId: Schema.String,
      revision: Revision,
      updatedAt: Schema.DateTimeUtcFromString,
    },
    success: Schema.Boolean,
    error: ConnectionError,
  }),
  Rpc.make("GetPullRequestStatus", {
    payload: { pullRequestId: Schema.String },
    success: PullRequestStatus,
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
  Rpc.make("MergePullRequest", {
    payload: { pullRequestId: Schema.String, revision: Revision, action: MergeAction },
    error: MergePullRequestError,
  }),
  Rpc.make("ReplyToReviewThread", {
    payload: { reviewThreadId: Schema.String, body: Schema.NonEmptyString },
    success: PublishedComment,
    error: ReplyError,
  }),
  Rpc.make("SetReviewThreadResolved", {
    payload: { reviewThreadId: Schema.String, resolved: Schema.Boolean },
    success: Schema.Boolean,
    error: ReviewThreadResolutionError,
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
  Rpc.make("WatchToDos", { success: Schema.Array(ToDo), error: ToDoError, stream: true }),
  Rpc.make("AddToDo", {
    payload: { title: ToDoTitle, notes: Schema.String, images: ToDoImageUploads },
    ...toDoList,
  }),
  Rpc.make("EditToDo", {
    payload: { id: Schema.Int, title: ToDoTitle, notes: Schema.String },
    ...toDoList,
  }),
  Rpc.make("SetToDoDone", { payload: { id: Schema.Int, done: Schema.Boolean }, ...toDoList }),
  Rpc.make("DeleteToDo", { payload: { id: Schema.Int }, ...toDoList }),
  Rpc.make("AttachToDoImages", {
    payload: { id: Schema.Int, images: ToDoImageUploads },
    ...toDoList,
  }),
  Rpc.make("RemoveToDoImage", { payload: { id: Schema.Int }, ...toDoList }),
  Rpc.make("ReadToDoImage", {
    payload: { id: Schema.Int, size: ToDoImageSize },
    success: Image,
    error: ToDoError,
  }),
  Rpc.make("WatchThreads", {
    success: Schema.Array(Thread),
    error: ThreadError,
    stream: true,
  }),
  Rpc.make("WatchWorkingThreads", { success: Schema.Array(Schema.String), stream: true }),
  Rpc.make("WatchUnseenTurns", { success: Schema.Array(UnseenTurn), stream: true }),
  Rpc.make("WatchBrowserPageRequests", {
    success: Schema.Array(BrowserPageRequest),
    stream: true,
  }),
  Rpc.make("AnswerBrowserPageRequest", {
    payload: { id: Schema.String, answer: BrowserPageAnswer },
  }),
  Rpc.make("WatchBrowserControl", { success: Schema.Array(BrowserControl), stream: true }),
  Rpc.make("TakeOverBrowser", { payload: { threadId: Schema.String } }),
  Rpc.make("HandBackBrowser", { payload: { threadId: Schema.String } }),
  Rpc.make("WatchSettledThreads", { success: Schema.Array(Schema.String), stream: true }),
  Rpc.make("BringBackThread", {
    payload: { threadId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("WatchThreadPullRequests", {
    success: Schema.Array(ThreadPullRequest),
    error: ThreadError,
    stream: true,
  }),
  Rpc.make("WatchSubscriptions", {
    payload: { threadId: Schema.String },
    success: Schema.Array(Subscription),
    error: ThreadError,
    stream: true,
  }),
  Rpc.make("EndSubscription", {
    payload: { threadId: Schema.String, subscriptionId: Schema.String },
    error: ThreadError,
  }),
  Rpc.make("WatchInbox", { success: InboxItems, stream: true }),
  Rpc.make("MarkTurnSeen", {
    payload: TurnSeen,
    error: ThreadError,
  }),
  Rpc.make("AnswerOutsideQuestion", {
    payload: { id: Schema.String, answer: OutsideQuestionAnswer },
    error: OutsideQuestionNotWaiting,
  }),
  Rpc.make("GetCheckInChanges", {
    payload: { checkInId: Schema.String },
    success: CheckInChanges,
    error: CheckInNotWaiting,
  }),
  Rpc.make("ListCheckInNotes", {
    payload: { checkInId: Schema.String },
    success: Schema.Array(LineNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("SaveCheckInNote", {
    payload: { checkInId: Schema.String, note: LineNote },
    success: Schema.Array(LineNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("RemoveCheckInNote", {
    payload: { checkInId: Schema.String, noteId: Schema.String },
    success: Schema.Array(LineNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("AnswerCheckIn", {
    payload: { checkInId: Schema.String, answer: CheckInAnswer },
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("GetMcpEndpoint", { success: Schema.Struct({ url: Schema.String }) }),
  Rpc.make("WatchOutsideAgents", { success: Schema.Array(OutsideAgent), stream: true }),
  Rpc.make("AnswerOutsideAgentRequest", {
    payload: { id: Schema.String, decision: OutsideAgentDecision },
    error: OutsideAgentRequestNotWaiting,
  }),
  Rpc.make("RevokeOutsideAgent", {
    payload: { id: Schema.String },
    error: OutsideAgentNotFound,
  }),
  Rpc.make("WatchTranscript", {
    payload: { threadId: Schema.String },
    success: TranscriptUpdate,
    error: Schema.Union([ThreadNotFound, ThreadError]),
    stream: true,
  }),
  Rpc.make("LoadEarlierTurns", {
    payload: { threadId: Schema.String, before: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ListLocalCheckouts", {
    success: Schema.Array(LocalCheckout),
    error: ThreadError,
  }),
  Rpc.make("LinkLocalCheckout", {
    payload: { path: Schema.String },
    success: LocalCheckout,
    error: Schema.Union([InvalidLocalCheckout, ThreadError]),
  }),
  Rpc.make("GetNewThreadDefaultBranch", {
    payload: { place: ThreadPlace, repository: FollowedRepository },
    success: Schema.NullOr(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, ThreadError]),
  }),
  Rpc.make("ListNewThreadBranches", {
    payload: { place: ThreadPlace, repository: FollowedRepository },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, ThreadError]),
  }),
  Rpc.make("ListAgentModels", {
    payload: { harness: AgentHarness, place: ThreadPlace },
    success: AgentModels,
    error: ThreadError,
  }),
  Rpc.make("ListNewThreadCommands", {
    payload: { harness: AgentHarness, place: ThreadPlace, repository: FollowedRepository },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([InvalidLocalCheckout, ThreadError]),
  }),
  Rpc.make("ListThreadCommands", {
    payload: { threadId: Schema.String },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ListNewThreadFiles", {
    payload: {
      place: ThreadPlace,
      repository: FollowedRepository,
      baseBranch: Schema.String,
    },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ThreadError]),
  }),
  Rpc.make("ListThreadFiles", {
    payload: { threadId: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("FindThreadFiles", {
    payload: { threadId: Schema.String, paths: NamedPaths },
    success: Schema.Array(Schema.String),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("GetThreadFile", {
    payload: { threadId: Schema.String, path: Schema.String },
    success: ThreadFile,
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ListSandboxProviders", { success: Schema.Array(SandboxProviderInfo) }),
  Rpc.make("CreateThread", {
    payload: NewThread,
    success: Thread,
    error: Schema.Union([InvalidLocalCheckout, ThreadError]),
  }),
  Rpc.make("SendMessage", {
    payload: SendThreadMessage,
    error: Schema.Union([ThreadNotFound, RequestWaiting, ThreadError]),
  }),
  Rpc.make("Steer", {
    payload: { threadId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([ThreadNotFound, RequestWaiting, ThreadError]),
  }),
  Rpc.make("CancelQueuedMessage", {
    payload: { threadId: Schema.String, queuedMessageId: Schema.String },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([ThreadNotFound, QueuedMessageStarted, ThreadError]),
  }),
  Rpc.make("SendQueuedMessage", {
    payload: { threadId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadBusy, ThreadError]),
  }),
  Rpc.make("StopTurn", {
    payload: { threadId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("StopBackgroundTask", {
    payload: { threadId: Schema.String, taskId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ReachSandbox", {
    payload: { threadId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("GetUnsentMessage", {
    payload: { threadId: Schema.String },
    success: SentMessage,
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("SaveUnsentMessage", {
    payload: { threadId: Schema.String, ...SentMessage.fields },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ChangeThreadModel", {
    payload: { threadId: Schema.String, ...ModelChoice.fields },
    success: Thread,
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ChangePermissionMode", {
    payload: { threadId: Schema.String, permissionMode: PermissionMode },
    success: Thread,
    error: Schema.Union([ThreadNotFound, NoPermissionModes, ThreadError]),
  }),
  Rpc.make("AnswerRequest", {
    payload: { threadId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([ThreadNotFound, RequestNotWaiting, ThreadError]),
  }),
  Rpc.make("GetRemovalWarnings", {
    payload: { threadId: Schema.String },
    success: RemovalWarnings,
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("GetThreadChanges", {
    payload: { threadId: Schema.String },
    success: ThreadChanges,
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("ListFeedbackNotes", {
    payload: { threadId: Schema.String },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("SaveFeedbackNote", {
    payload: { threadId: Schema.String, note: FeedbackNote },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("RemoveFeedbackNote", {
    payload: { threadId: Schema.String, noteId: Schema.String },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("RemoveThread", {
    payload: { threadId: Schema.String },
    error: Schema.Union([ThreadNotFound, ThreadError]),
  }),
  Rpc.make("GetGlobalChatModel", {
    success: ModelChoice,
    error: ThreadError,
  }),
  Rpc.make("ChangeGlobalChatModel", {
    payload: ModelChoice.fields,
    error: ThreadError,
  }),
  Rpc.make("WatchGlobalTranscript", {
    success: TranscriptUpdate,
    error: ThreadError,
    stream: true,
  }),
  Rpc.make("LoadEarlierGlobalTurns", {
    payload: { before: Schema.String },
    error: ThreadError,
  }),
  Rpc.make("SendGlobalMessage", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, ThreadError]),
  }),
  Rpc.make("SteerGlobal", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, ThreadError]),
  }),
  Rpc.make("CancelGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: Schema.Union([QueuedMessageStarted, ThreadError]),
  }),
  Rpc.make("SendGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: Schema.Union([ThreadBusy, ThreadError]),
  }),
  Rpc.make("StopGlobalTurn", { error: ThreadError }),
  Rpc.make("AnswerGlobalRequest", {
    payload: { requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, ThreadError]),
  }),
  Rpc.make("GetGlobalUnsentMessage", { success: SentMessage, error: ThreadError }),
  Rpc.make("SaveGlobalUnsentMessage", { payload: SentMessage, error: ThreadError }),
  Rpc.make("WatchGlobalUnseen", { success: Schema.NullOr(TurnEnd), stream: true }),
  Rpc.make("MarkGlobalTurnSeen", {
    payload: { endedAt: Schema.DateTimeUtcFromString },
    error: ThreadError,
  }),
  Rpc.make("StartGlobalChatFresh", {
    error: Schema.Union([StartFreshRefused, ThreadError]),
  }),
  Rpc.make("ListEndedGlobalChatSessions", {
    success: Schema.Array(EndedGlobalChatSession),
    error: ThreadError,
  }),
  Rpc.make("WatchGlobalChatSession", {
    payload: { id: Schema.String },
    success: TranscriptUpdate,
    error: Schema.Union([GlobalChatSessionNotFound, ThreadError]),
    stream: true,
  }),
  Rpc.make("LoadEarlierGlobalChatSessionTurns", {
    payload: { id: Schema.String, before: Schema.String },
    error: Schema.Union([GlobalChatSessionNotFound, ThreadError]),
  }),
) {}

export type GlassRpcError = Rpc.Error<RpcGroup.Rpcs<typeof GlassRpcs>>

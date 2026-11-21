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
  Conversation,
  ConversationBusy,
  ConversationChanges,
  AgentCommand,
  AgentHarness,
  ConversationError,
  AgentModels,
  ConversationPlace,
  ConversationNotFound,
  EndedGlobalChatSession,
  GlobalChatSessionNotFound,
  Image,
  InvalidLocalCheckout,
  LocalCheckout,
  MessageInput,
  MessageInputWithContext,
  ModelChoice,
  NewConversation,
  NoPermissionModes,
  PermissionMode,
  QueuedMessageStarted,
  RemovalWarnings,
  RequestAnswer,
  RequestNotWaiting,
  RequestWaiting,
  SandboxProviderInfo,
  SendConversationMessage,
  SentMessage,
  StartFreshRefused,
  TranscriptUpdate,
  TurnEnd,
  ConversationFile,
  NamedPaths,
} from "./conversation"
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
import { FeedbackNote, UnsentFeedback } from "./feedbackNote"
import { CheckInAnswer, CheckInChanges, CheckInError, CheckInNotWaiting } from "./checkIn"
import { FollowedRepository, InvalidRepositoryInput } from "./followedRepository"
import { MergeAction, MergePullRequestError } from "./merge"
import { NeedsYou, OutsideQuestionAnswer, OutsideQuestionNotWaiting, TurnSeen } from "./needsYou"
import { OutsideAgent, OutsideAgentNotFound } from "./outsideAgent"
import { LoadPullRequestError, PullRequestRef, PullRequestWorkspace } from "./pullRequest"
import {
  ConversationPullRequest,
  LatestPullRequestListings,
  PullRequestListings,
} from "./pullRequestList"
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
import { ToDo, ToDoError, ToDoImageSize, ToDoImageUploads, ToDoTitle } from "./toDo"
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
  Rpc.make("WatchConversations", {
    success: Schema.Array(Conversation),
    error: ConversationError,
    stream: true,
  }),
  Rpc.make("WatchWorkingConversations", { success: Schema.Array(Schema.String), stream: true }),
  Rpc.make("WatchSettledConversations", { success: Schema.Array(Schema.String), stream: true }),
  Rpc.make("BringBackConversation", {
    payload: { conversationId: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("WatchConversationPullRequests", {
    success: Schema.Array(ConversationPullRequest),
    error: ConversationError,
    stream: true,
  }),
  Rpc.make("WatchNeedsYou", { success: NeedsYou, stream: true }),
  Rpc.make("MarkTurnSeen", {
    payload: TurnSeen,
    error: ConversationError,
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
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("SaveCheckInNote", {
    payload: { checkInId: Schema.String, note: FeedbackNote },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("RemoveCheckInNote", {
    payload: { checkInId: Schema.String, noteId: Schema.String },
    success: Schema.Array(FeedbackNote),
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("AnswerCheckIn", {
    payload: { checkInId: Schema.String, answer: CheckInAnswer },
    error: Schema.Union([CheckInNotWaiting, CheckInError]),
  }),
  Rpc.make("GetMcpEndpoint", { success: Schema.Struct({ url: Schema.String }) }),
  Rpc.make("WatchOutsideAgents", { success: Schema.Array(OutsideAgent), stream: true }),
  Rpc.make("RevokeOutsideAgent", {
    payload: { id: Schema.String },
    error: OutsideAgentNotFound,
  }),
  Rpc.make("WatchTranscript", {
    payload: { conversationId: Schema.String },
    success: TranscriptUpdate,
    error: Schema.Union([ConversationNotFound, ConversationError]),
    stream: true,
  }),
  Rpc.make("LoadEarlierTurns", {
    payload: { conversationId: Schema.String, before: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ListLocalCheckouts", {
    success: Schema.Array(LocalCheckout),
    error: ConversationError,
  }),
  Rpc.make("LinkLocalCheckout", {
    payload: { path: Schema.String },
    success: LocalCheckout,
    error: Schema.Union([InvalidLocalCheckout, ConversationError]),
  }),
  Rpc.make("GetNewConversationDefaultBranch", {
    payload: { place: ConversationPlace, repository: FollowedRepository },
    success: Schema.NullOr(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, ConversationError]),
  }),
  Rpc.make("ListNewConversationBranches", {
    payload: { place: ConversationPlace, repository: FollowedRepository },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConnectionError, ConversationError]),
  }),
  Rpc.make("ListAgentModels", {
    payload: { harness: AgentHarness, place: ConversationPlace },
    success: AgentModels,
    error: ConversationError,
  }),
  Rpc.make("ListNewConversationCommands", {
    payload: { harness: AgentHarness, place: ConversationPlace, repository: FollowedRepository },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([InvalidLocalCheckout, ConversationError]),
  }),
  Rpc.make("ListConversationCommands", {
    payload: { conversationId: Schema.String },
    success: Schema.Array(AgentCommand),
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ListNewConversationFiles", {
    payload: {
      place: ConversationPlace,
      repository: FollowedRepository,
      baseBranch: Schema.String,
    },
    success: Schema.Array(Schema.String),
    error: Schema.Union([InvalidLocalCheckout, ConversationError]),
  }),
  Rpc.make("ListConversationFiles", {
    payload: { conversationId: Schema.String },
    success: Schema.Array(Schema.String),
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("FindConversationFiles", {
    payload: { conversationId: Schema.String, paths: NamedPaths },
    success: Schema.Array(Schema.String),
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("GetConversationFile", {
    payload: { conversationId: Schema.String, path: Schema.String },
    success: ConversationFile,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ListSandboxProviders", { success: Schema.Array(SandboxProviderInfo) }),
  Rpc.make("CreateConversation", {
    payload: NewConversation,
    success: Conversation,
    error: Schema.Union([InvalidLocalCheckout, ConversationError]),
  }),
  Rpc.make("SendMessage", {
    payload: SendConversationMessage,
    error: Schema.Union([ConversationNotFound, RequestWaiting, ConversationError]),
  }),
  Rpc.make("Steer", {
    payload: { conversationId: Schema.String, ...MessageInput.fields },
    error: Schema.Union([ConversationNotFound, RequestWaiting, ConversationError]),
  }),
  Rpc.make("CancelQueuedMessage", {
    payload: { conversationId: Schema.String, queuedMessageId: Schema.String },
    success: UnsentFeedback,
    error: Schema.Union([ConversationNotFound, QueuedMessageStarted, ConversationError]),
  }),
  Rpc.make("SendQueuedMessage", {
    payload: { conversationId: Schema.String, queuedMessageId: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationBusy, ConversationError]),
  }),
  Rpc.make("StopTurn", {
    payload: { conversationId: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ReachSandbox", {
    payload: { conversationId: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("GetUnsentMessage", {
    payload: { conversationId: Schema.String },
    success: SentMessage,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("SaveUnsentMessage", {
    payload: { conversationId: Schema.String, ...SentMessage.fields },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ChangeConversationModel", {
    payload: { conversationId: Schema.String, ...ModelChoice.fields },
    success: Conversation,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ChangePermissionMode", {
    payload: { conversationId: Schema.String, permissionMode: PermissionMode },
    success: Conversation,
    error: Schema.Union([ConversationNotFound, NoPermissionModes, ConversationError]),
  }),
  Rpc.make("AnswerRequest", {
    payload: { conversationId: Schema.String, requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([ConversationNotFound, RequestNotWaiting, ConversationError]),
  }),
  Rpc.make("GetRemovalWarnings", {
    payload: { conversationId: Schema.String },
    success: RemovalWarnings,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("GetConversationChanges", {
    payload: { conversationId: Schema.String },
    success: ConversationChanges,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("ListFeedbackNotes", {
    payload: { conversationId: Schema.String },
    success: UnsentFeedback,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("StageFeedbackNotes", {
    payload: { conversationId: Schema.String },
    success: UnsentFeedback,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("SaveFeedbackNote", {
    payload: { conversationId: Schema.String, note: FeedbackNote },
    success: UnsentFeedback,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("RemoveFeedbackNote", {
    payload: { conversationId: Schema.String, noteId: Schema.String },
    success: UnsentFeedback,
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("RemoveConversation", {
    payload: { conversationId: Schema.String },
    error: Schema.Union([ConversationNotFound, ConversationError]),
  }),
  Rpc.make("GetGlobalChatModel", {
    success: ModelChoice,
    error: ConversationError,
  }),
  Rpc.make("ChangeGlobalChatModel", {
    payload: ModelChoice.fields,
    error: ConversationError,
  }),
  Rpc.make("WatchGlobalTranscript", {
    success: TranscriptUpdate,
    error: ConversationError,
    stream: true,
  }),
  Rpc.make("LoadEarlierGlobalTurns", {
    payload: { before: Schema.String },
    error: ConversationError,
  }),
  Rpc.make("SendGlobalMessage", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, ConversationError]),
  }),
  Rpc.make("SteerGlobal", {
    payload: MessageInputWithContext,
    error: Schema.Union([RequestWaiting, ConversationError]),
  }),
  Rpc.make("CancelGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: Schema.Union([QueuedMessageStarted, ConversationError]),
  }),
  Rpc.make("SendGlobalQueuedMessage", {
    payload: { queuedMessageId: Schema.String },
    error: Schema.Union([ConversationBusy, ConversationError]),
  }),
  Rpc.make("StopGlobalTurn", { error: ConversationError }),
  Rpc.make("AnswerGlobalRequest", {
    payload: { requestId: Schema.String, answer: RequestAnswer },
    error: Schema.Union([RequestNotWaiting, ConversationError]),
  }),
  Rpc.make("GetGlobalUnsentMessage", { success: SentMessage, error: ConversationError }),
  Rpc.make("SaveGlobalUnsentMessage", { payload: SentMessage, error: ConversationError }),
  Rpc.make("WatchGlobalUnseen", { success: Schema.NullOr(TurnEnd), stream: true }),
  Rpc.make("MarkGlobalTurnSeen", {
    payload: { endedAt: Schema.DateTimeUtcFromString },
    error: ConversationError,
  }),
  Rpc.make("StartGlobalChatFresh", {
    error: Schema.Union([StartFreshRefused, ConversationError]),
  }),
  Rpc.make("ListEndedGlobalChatSessions", {
    success: Schema.Array(EndedGlobalChatSession),
    error: ConversationError,
  }),
  Rpc.make("WatchGlobalChatSession", {
    payload: { id: Schema.String },
    success: TranscriptUpdate,
    error: Schema.Union([GlobalChatSessionNotFound, ConversationError]),
    stream: true,
  }),
  Rpc.make("LoadEarlierGlobalChatSessionTurns", {
    payload: { id: Schema.String, before: Schema.String },
    error: Schema.Union([GlobalChatSessionNotFound, ConversationError]),
  }),
) {}

export type GlassRpcError = Rpc.Error<RpcGroup.Rpcs<typeof GlassRpcs>>

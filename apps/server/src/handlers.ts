import { GlassRpcs } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { ConversationPullRequests } from "./ConversationPullRequests"
import { Conversations } from "./Conversations"
import { GitHubClient } from "./github/GitHubClient"
import { GlobalChat } from "./GlobalChat"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { FollowedRepositories } from "./FollowedRepositories"
import { LocalCheckouts } from "./LocalCheckouts"
import { NeedsYou } from "./NeedsYou"
import { OutsideAgents } from "./OutsideAgents"
import { OutsideQuestions } from "./OutsideQuestions"
import { CheckIns } from "./CheckIns"
import { McpCredentials } from "./mcp/McpCredentials"
import { PullRequestLists } from "./PullRequestLists"
import { PullRequestWorkspaces } from "./PullRequestWorkspaces"
import { Queue } from "./Queue"
import { engineSettingsOf, SettingsStore, withEngineSettings } from "./SettingsStore"
import { Sandboxes } from "./Sandboxes"
import { SavedPlaces } from "./SavedPlaces"
import { SettledConversations } from "./SettledConversations"
import { LocalSkills } from "./LocalSkills"
import { SkillPacks } from "./SkillPacks"
import { Storage } from "./Storage"
import { ToDos } from "./ToDos"
import { Tours } from "./Tours"

export const GlassRpcHandlers = GlassRpcs.toLayer(
  Effect.gen(function* () {
    const github = yield* GitHubClient
    const activityLog = yield* ActivityLog
    const repositories = yield* FollowedRepositories
    const lists = yield* PullRequestLists
    const toDos = yield* ToDos
    const tours = yield* Tours
    const agentReviews = yield* AgentReviews
    const asks = yield* Asks
    const queue = yield* Queue
    const workspaces = yield* PullRequestWorkspaces
    const settings = yield* SettingsStore
    const savedPlaces = yield* SavedPlaces
    const conversations = yield* Conversations
    const globalChat = yield* GlobalChat
    const sandboxes = yield* Sandboxes
    const checkouts = yield* LocalCheckouts
    const storage = yield* Storage
    const skillPacks = yield* SkillPacks
    const localSkills = yield* LocalSkills
    const needsYou = yield* NeedsYou
    const conversationPullRequests = yield* ConversationPullRequests
    const settledConversations = yield* SettledConversations
    const outsideQuestions = yield* OutsideQuestions
    const checkIns = yield* CheckIns
    const outsideAgents = yield* OutsideAgents
    const mcpCredentials = yield* McpCredentials

    return GlassRpcs.of({
      GetSavedPlaces: () => savedPlaces.list(),
      SavePlace: ({ destination }) => savedPlaces.save(destination),
      WriteTour: ({ pullRequest, revision }) => tours.write(pullRequest, revision),
      CancelTour: ({ pullRequest }) => tours.cancel(pullRequest),
      WatchTour: ({ pullRequest }) => tours.watch(pullRequest),
      StartAgentReview: ({ pullRequest, revision }) => agentReviews.start(pullRequest, revision),
      FollowUpAgentReview: ({ pullRequest, revision, message }) =>
        agentReviews.followUp(pullRequest, revision, message),
      CancelAgentReview: ({ pullRequest }) => agentReviews.cancel(pullRequest),
      MarkAgentReviewDone: ({ pullRequest, writtenAt }) =>
        agentReviews.markDone(pullRequest, writtenAt),
      Ask: ({ pullRequest, revision, place, question }) =>
        asks.ask(pullRequest, revision, place, question),
      WatchAgentReview: ({ pullRequest }) => agentReviews.watch(pullRequest),
      GetReviewPrompt: () => settings.read().pipe(Effect.map(({ reviewPrompt }) => reviewPrompt)),
      SetReviewPrompt: ({ prompt }) =>
        settings
          .update((current) => ({ ...current, reviewPrompt: prompt }))
          .pipe(Effect.map(({ reviewPrompt }) => reviewPrompt)),
      GetEngineSettings: ({ feature }) =>
        settings.read().pipe(Effect.map((current) => engineSettingsOf(current, feature))),
      SetEngineSettings: ({ feature, engineSettings }) =>
        settings
          .update((current) => withEngineSettings(current, feature, engineSettings))
          .pipe(Effect.map((updated) => engineSettingsOf(updated, feature))),
      GetQueueWork: ({ feature }) => queue.enabled(feature),
      SetQueueWork: ({ feature, enabled }) => queue.setEnabled(feature, enabled),
      GetStorageBreakdown: () => storage.breakdown,
      ListFollowedRepositories: () => repositories.list(),
      FollowRepository: ({ input }) => repositories.follow(input),
      UnfollowRepository: ({ repository }) => repositories.unfollow(repository),
      ListSkillPacks: () => skillPacks.list(),
      PreviewSkillPack: ({ url }) => skillPacks.preview(url),
      AddSkillPack: ({ source, commit, name }) => skillPacks.add(source, commit, name),
      PreviewSkillPackUpdate: ({ name }) => skillPacks.previewUpdate(name),
      UpdateSkillPack: ({ name, commit }) => skillPacks.update(name, commit),
      RemoveSkillPack: ({ name }) => skillPacks.remove(name),
      ListLocalSkills: ({ harness }) => localSkills.names(harness),
      ListPullRequests: () =>
        lists.list().pipe(Effect.provideService(BackgroundGitHubRequest, true)),
      WatchPullRequests: () => lists.watch(),
      ListSavedQueue: () => queue.saved(),
      RefreshQueue: () =>
        queue.refresh().pipe(Effect.provideService(BackgroundGitHubRequest, true)),
      AddToQueue: ({ references }) => queue.add(references),
      RemoveFromQueue: ({ reference }) => queue.remove(reference),
      RestoreToQueue: ({ queued }) => queue.restore(queued),
      GetConnection: () => github.viewer,
      LoadPullRequest: ({ pullRequest: ref }) => workspaces.open(ref),
      HasPullRequestChanged: ({ pullRequestId, revision, updatedAt }) =>
        github
          .hasChanged(pullRequestId, revision, updatedAt)
          .pipe(Effect.provideService(BackgroundGitHubRequest, true)),
      GetFileContents: ({ pullRequest, revision, side, path }) =>
        github.fileContents(pullRequest, revision, side, path),
      ListRepositoryFiles: ({ pullRequest, revision }) =>
        github.repositoryFiles(pullRequest, revision.head),
      SetFileViewed: ({ pullRequestId, revision, path, viewed }) =>
        github.setFileViewed(pullRequestId, revision, path, viewed),
      CreateDraft: (draft) => github.createDraft(draft),
      UpdateDraft: ({ id, body }) => github.updateDraft(id, body),
      DeleteDraft: ({ id }) => github.deleteDraft(id),
      SubmitReview: ({ pullRequestId, revision, decision, summary }) =>
        github
          .submitReview(pullRequestId, revision, decision, summary)
          .pipe(Effect.tap(() => queue.reviewed(pullRequestId))),
      ReplyToDiscussion: ({ discussionId, body }) => github.replyToDiscussion(discussionId, body),
      MergePullRequest: ({ pullRequestId, revision, action }) =>
        github.mergePullRequest(pullRequestId, revision, action),
      SetDiscussionResolved: ({ discussionId, resolved }) =>
        github.setDiscussionResolved(discussionId, resolved),
      SetReaction: ({ commentId, reaction, reacted }) =>
        github.setReaction(commentId, reaction, reacted),
      RecordActivity: (activity) =>
        activityLog
          .record(activity)
          .pipe(
            Effect.andThen(
              Predicate.isTagged(activity, "PullRequestOpened")
                ? queue.opened(activity.pullRequest.ref)
                : Effect.void,
            ),
          ),
      ListActivity: ({ limit }) =>
        github.viewer.pipe(Effect.flatMap(({ login }) => activityLog.list(login, limit))),
      ListActivityStamps: ({ since, kinds }) =>
        github.viewer.pipe(Effect.flatMap(({ login }) => activityLog.stamps(login, since, kinds))),
      ListToDos: () => toDos.list(),
      AddToDo: ({ title, notes, images = [] }) => toDos.add(title, notes, images),
      EditToDo: ({ id, title, notes }) => toDos.edit(id, title, notes),
      SetToDoDone: ({ id, done }) => toDos.setDone(id, done),
      DeleteToDo: ({ id }) => toDos.remove(id),
      AttachToDoImages: ({ id, images = [] }) => toDos.attach(id, images),
      RemoveToDoImage: ({ id }) => toDos.removeImage(id),
      ReadToDoImage: ({ id, size }) => toDos.readImage(id, size),
      WatchConversations: () => conversations.watch(),
      WatchTranscript: ({ conversationId }) => conversations.transcript(conversationId),
      LoadEarlierTurns: ({ conversationId, before }) =>
        conversations.loadEarlierTurns(conversationId, before),
      ListLocalCheckouts: () => checkouts.list(),
      LinkLocalCheckout: ({ path }) => checkouts.link(path),
      GetNewConversationDefaultBranch: ({ place, repository }) =>
        conversations.newConversationDefaultBranch(place, repository),
      ListNewConversationBranches: ({ place, repository }) =>
        conversations.newConversationBranches(place, repository),
      ListAgentModels: ({ harness, place }) => conversations.models(harness, place),
      ListNewConversationCommands: ({ harness, place, repository }) =>
        conversations.newConversationCommands(harness, place, repository),
      ListConversationCommands: ({ conversationId }) => conversations.commands(conversationId),
      ListNewConversationFiles: ({ place, repository, baseBranch }) =>
        conversations.newConversationFiles(place, repository, baseBranch),
      ListConversationFiles: ({ conversationId }) => conversations.files(conversationId),
      FindConversationFiles: ({ conversationId, paths }) =>
        conversations.existingFiles(conversationId, paths),
      GetConversationFile: ({ conversationId, path }) => conversations.file(conversationId, path),
      ListSandboxProviders: () => Effect.succeed(sandboxes.providers),
      CreateConversation: (input) => conversations.create(input),
      WatchWorkingConversations: () => conversations.watchWorking(),
      WatchConversationPullRequests: () => conversationPullRequests.watch(),
      WatchSettledConversations: () => settledConversations.watch(),
      BringBackConversation: ({ conversationId }) => conversations.bringBack(conversationId),
      WatchNeedsYou: () => needsYou.watch(),
      MarkTurnSeen: ({ conversationId, endedAt }) =>
        conversations.markTurnSeen(conversationId, endedAt),
      AnswerOutsideQuestion: ({ id, answer }) => outsideQuestions.answer(id, answer),
      GetCheckInChanges: ({ checkInId }) => checkIns.changes(checkInId),
      ListCheckInNotes: ({ checkInId }) => checkIns.notes(checkInId),
      SaveCheckInNote: ({ checkInId, note }) => checkIns.saveNote(checkInId, note),
      RemoveCheckInNote: ({ checkInId, noteId }) => checkIns.removeNote(checkInId, noteId),
      AnswerCheckIn: ({ checkInId, answer }) => checkIns.answer(checkInId, answer),
      GetMcpEndpoint: () => mcpCredentials.endpoint.pipe(Effect.map((url) => ({ url }))),
      WatchOutsideAgents: () => outsideAgents.watch(),
      RevokeOutsideAgent: ({ id }) => outsideAgents.revoke(id),
      ChangeConversationModel: ({ conversationId, model, effort }) =>
        conversations.changeModel(conversationId, { model, effort }),
      ChangePermissionMode: ({ conversationId, permissionMode }) =>
        conversations.changePermissionMode(conversationId, permissionMode),
      AnswerRequest: ({ conversationId, requestId, answer }) =>
        conversations.answer(conversationId, requestId, answer),
      SendMessage: ({ conversationId, message, images, feedback }) =>
        conversations.send(conversationId, { message, images }, feedback).pipe(Effect.asVoid),
      Steer: ({ conversationId, message, images }) =>
        conversations.steer(conversationId, { message, images }),
      CancelQueuedMessage: ({ conversationId, queuedMessageId }) =>
        conversations.cancelQueued(conversationId, queuedMessageId),
      SendQueuedMessage: ({ conversationId, queuedMessageId }) =>
        conversations.sendQueued(conversationId, queuedMessageId),
      StopTurn: ({ conversationId }) => conversations.stop(conversationId),
      ReachSandbox: ({ conversationId }) => conversations.reachSandbox(conversationId),
      GetUnsentMessage: ({ conversationId }) => conversations.unsent(conversationId),
      SaveUnsentMessage: ({ conversationId, message, images }) =>
        conversations.saveUnsent(conversationId, { message, images }),
      GetConversationChanges: ({ conversationId }) => conversations.changes(conversationId),
      ListFeedbackNotes: ({ conversationId }) => conversations.feedbackNotes(conversationId),
      StageFeedbackNotes: ({ conversationId }) => conversations.stageFeedbackNotes(conversationId),
      SaveFeedbackNote: ({ conversationId, note }) =>
        conversations.saveFeedbackNote(conversationId, note),
      RemoveFeedbackNote: ({ conversationId, noteId }) =>
        conversations.removeFeedbackNote(conversationId, noteId),
      GetRemovalWarnings: ({ conversationId }) => conversations.removalWarnings(conversationId),
      RemoveConversation: ({ conversationId }) => conversations.remove(conversationId),
      GetGlobalChatModel: () => globalChat.model,
      ChangeGlobalChatModel: (choice) => globalChat.changeModel(choice),
      WatchGlobalTranscript: () => globalChat.transcript,
      LoadEarlierGlobalTurns: ({ before }) => globalChat.loadEarlier(before),
      SendGlobalMessage: (input) => globalChat.send(input),
      SteerGlobal: (input) => globalChat.steer(input),
      CancelGlobalQueuedMessage: ({ queuedMessageId }) => globalChat.cancelQueued(queuedMessageId),
      SendGlobalQueuedMessage: ({ queuedMessageId }) => globalChat.sendQueued(queuedMessageId),
      StopGlobalTurn: () => globalChat.stop,
      AnswerGlobalRequest: ({ requestId, answer }) => globalChat.answer(requestId, answer),
      GetGlobalUnsentMessage: () => globalChat.unsent,
      SaveGlobalUnsentMessage: (unsent) => globalChat.saveUnsent(unsent),
      WatchGlobalUnseen: () => globalChat.unseen,
      MarkGlobalTurnSeen: ({ endedAt }) => globalChat.markSeen(endedAt),
      StartGlobalChatFresh: () => globalChat.startFresh,
      ListEndedGlobalChatSessions: () => globalChat.endedSessions,
      WatchGlobalChatSession: ({ id }) => globalChat.watchSession(id),
      LoadEarlierGlobalChatSessionTurns: ({ id, before }) =>
        globalChat.loadEarlierInSession(id, before),
    })
  }),
)

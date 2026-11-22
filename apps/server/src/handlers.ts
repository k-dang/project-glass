import { GlassRpcs } from "@glass/contracts"
import { Effect, Predicate } from "effect"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { BrowserPages } from "./BrowserPages"
import { ThreadPullRequests } from "./ThreadPullRequests"
import { Threads } from "./Threads"
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
import { SettledThreads } from "./SettledThreads"
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
    const threads = yield* Threads
    const browserPages = yield* BrowserPages
    const globalChat = yield* GlobalChat
    const sandboxes = yield* Sandboxes
    const checkouts = yield* LocalCheckouts
    const storage = yield* Storage
    const skillPacks = yield* SkillPacks
    const localSkills = yield* LocalSkills
    const needsYou = yield* NeedsYou
    const threadPullRequests = yield* ThreadPullRequests
    const settledThreads = yield* SettledThreads
    const outsideQuestions = yield* OutsideQuestions
    const checkIns = yield* CheckIns
    const outsideAgents = yield* OutsideAgents
    const mcpCredentials = yield* McpCredentials

    const handingBack =
      (threadId: string) =>
      <A, E, R>(sent: Effect.Effect<A, E, R>) =>
        browserPages
          .handBack(threadId)
          .pipe(
            Effect.flatMap((tookOver) =>
              sent.pipe(
                Effect.tapError(() => (tookOver ? browserPages.takeOver(threadId) : Effect.void)),
              ),
            ),
          )

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
      GetPullRequestStatus: ({ pullRequestId }) =>
        github
          .pullRequestStatus(pullRequestId)
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
      ReplyToReviewThread: ({ reviewThreadId, body }) =>
        github.replyToReviewThread(reviewThreadId, body),
      MergePullRequest: ({ pullRequestId, revision, action }) =>
        github
          .mergePullRequest(pullRequestId, revision, action)
          .pipe(Effect.andThen(lists.refreshSoon)),
      SetReviewThreadResolved: ({ reviewThreadId, resolved }) =>
        github.setReviewThreadResolved(reviewThreadId, resolved),
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
      WatchToDos: () => toDos.watch(),
      AddToDo: ({ title, notes, images = [] }) => toDos.add(title, notes, images),
      EditToDo: ({ id, title, notes }) => toDos.edit(id, title, notes),
      SetToDoDone: ({ id, done }) => toDos.setDone(id, done),
      DeleteToDo: ({ id }) => toDos.remove(id),
      AttachToDoImages: ({ id, images = [] }) => toDos.attach(id, images),
      RemoveToDoImage: ({ id }) => toDos.removeImage(id),
      ReadToDoImage: ({ id, size }) => toDos.readImage(id, size),
      WatchThreads: () => threads.watch(),
      WatchTranscript: ({ threadId }) => threads.transcript(threadId),
      LoadEarlierTurns: ({ threadId, before }) => threads.loadEarlierTurns(threadId, before),
      ListLocalCheckouts: () => checkouts.list(),
      LinkLocalCheckout: ({ path }) => checkouts.link(path),
      GetNewThreadDefaultBranch: ({ place, repository }) =>
        threads.newThreadDefaultBranch(place, repository),
      ListNewThreadBranches: ({ place, repository }) =>
        threads.newThreadBranches(place, repository),
      ListAgentModels: ({ harness, place }) => threads.models(harness, place),
      ListNewThreadCommands: ({ harness, place, repository }) =>
        threads.newThreadCommands(harness, place, repository),
      ListThreadCommands: ({ threadId }) => threads.commands(threadId),
      ListNewThreadFiles: ({ place, repository, baseBranch }) =>
        threads.newThreadFiles(place, repository, baseBranch),
      ListThreadFiles: ({ threadId }) => threads.files(threadId),
      FindThreadFiles: ({ threadId, paths }) => threads.existingFiles(threadId, paths),
      GetThreadFile: ({ threadId, path }) => threads.file(threadId, path),
      ListSandboxProviders: () => Effect.succeed(sandboxes.providers),
      CreateThread: (input) => threads.create(input),
      WatchWorkingThreads: () => threads.watchWorking(),
      WatchBrowserPageRequests: () => browserPages.requests,
      AnswerBrowserPageRequest: ({ id, answer }) => browserPages.answer(id, answer),
      WatchBrowserControl: () => browserPages.control,
      TakeOverBrowser: ({ threadId }) => browserPages.takeOver(threadId),
      HandBackBrowser: ({ threadId }) => browserPages.handBack(threadId).pipe(Effect.asVoid),
      WatchThreadPullRequests: () => threadPullRequests.watch(),
      WatchSettledThreads: () => settledThreads.watch(),
      BringBackThread: ({ threadId }) => threads.bringBack(threadId),
      WatchNeedsYou: () => needsYou.watch(),
      MarkTurnSeen: ({ threadId, endedAt }) => threads.markTurnSeen(threadId, endedAt),
      AnswerOutsideQuestion: ({ id, answer }) => outsideQuestions.answer(id, answer),
      GetCheckInChanges: ({ checkInId }) => checkIns.changes(checkInId),
      ListCheckInNotes: ({ checkInId }) => checkIns.notes(checkInId),
      SaveCheckInNote: ({ checkInId, note }) => checkIns.saveNote(checkInId, note),
      RemoveCheckInNote: ({ checkInId, noteId }) => checkIns.removeNote(checkInId, noteId),
      AnswerCheckIn: ({ checkInId, answer }) => checkIns.answer(checkInId, answer),
      GetMcpEndpoint: () => mcpCredentials.endpoint.pipe(Effect.map((url) => ({ url }))),
      WatchOutsideAgents: () => outsideAgents.watch(),
      RevokeOutsideAgent: ({ id }) => outsideAgents.revoke(id),
      ChangeThreadModel: ({ threadId, model, effort }) =>
        threads.changeModel(threadId, { model, effort }),
      ChangePermissionMode: ({ threadId, permissionMode }) =>
        threads.changePermissionMode(threadId, permissionMode),
      AnswerRequest: ({ threadId, requestId, answer }) =>
        threads.answer(threadId, requestId, answer),
      SendMessage: ({ threadId, message, images, feedback }) =>
        threads
          .send(threadId, { message, images }, feedback)
          .pipe(handingBack(threadId), Effect.asVoid),
      Steer: ({ threadId, message, images }) =>
        threads.steer(threadId, { message, images }).pipe(handingBack(threadId)),
      CancelQueuedMessage: ({ threadId, queuedMessageId }) =>
        threads.cancelQueued(threadId, queuedMessageId),
      SendQueuedMessage: ({ threadId, queuedMessageId }) =>
        threads.sendQueued(threadId, queuedMessageId).pipe(handingBack(threadId)),
      StopTurn: ({ threadId }) => threads.stop(threadId),
      ReachSandbox: ({ threadId }) => threads.reachSandbox(threadId),
      GetUnsentMessage: ({ threadId }) => threads.unsent(threadId),
      SaveUnsentMessage: ({ threadId, message, images }) =>
        threads.saveUnsent(threadId, { message, images }),
      GetThreadChanges: ({ threadId }) => threads.changes(threadId),
      ListFeedbackNotes: ({ threadId }) => threads.feedbackNotes(threadId),
      StageFeedbackNotes: ({ threadId }) => threads.stageFeedbackNotes(threadId),
      SaveFeedbackNote: ({ threadId, note }) => threads.saveFeedbackNote(threadId, note),
      RemoveFeedbackNote: ({ threadId, noteId }) => threads.removeFeedbackNote(threadId, noteId),
      GetRemovalWarnings: ({ threadId }) => threads.removalWarnings(threadId),
      RemoveThread: ({ threadId }) => threads.remove(threadId),
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

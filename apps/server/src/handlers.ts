import { GlassRpcs } from "@glass/contracts"
import { Effect, Predicate, Stream } from "effect"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { Agents } from "./Agents"
import { GitHubClient } from "./github/GitHubClient"
import { GlobalConversation } from "./GlobalConversation"
import { BackgroundGitHubRequest } from "./github/GitHubRequestPolicy"
import { FollowedRepositories } from "./FollowedRepositories"
import { LocalCheckouts } from "./LocalCheckouts"
import { NeedsYou } from "./NeedsYou"
import { PullRequestLists } from "./PullRequestLists"
import { PullRequestWorkspaces } from "./PullRequestWorkspaces"
import { Queue } from "./Queue"
import { engineSettingsOf, SettingsStore, withEngineSettings } from "./SettingsStore"
import { Sandboxes } from "./Sandboxes"
import { SavedPlaces } from "./SavedPlaces"
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
    const agents = yield* Agents
    const globalConversation = yield* GlobalConversation
    const sandboxes = yield* Sandboxes
    const checkouts = yield* LocalCheckouts
    const storage = yield* Storage
    const skillPacks = yield* SkillPacks
    const localSkills = yield* LocalSkills
    const needsYou = yield* NeedsYou

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
      ListLocalSkills: ({ engine }) => localSkills.names(engine),
      ListPullRequests: () =>
        lists.list().pipe(Effect.provideService(BackgroundGitHubRequest, true)),
      ListSavedPullRequests: () => lists.saved(),
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
      AddToDo: ({ title }) => toDos.add(title),
      EditToDo: ({ id, title, notes }) => toDos.edit(id, title, notes),
      SetToDoDone: ({ id, done }) => toDos.setDone(id, done),
      DeleteToDo: ({ id }) => toDos.remove(id),
      WatchAgents: () => agents.watch(),
      WatchTranscript: ({ agentId }) => agents.transcript(agentId),
      ListLocalCheckouts: () => checkouts.list(),
      LinkLocalCheckout: ({ path }) => checkouts.link(path),
      GetNewAgentDefaultBranch: ({ place, repository }) =>
        agents.newAgentDefaultBranch(place, repository),
      ListNewAgentBranches: ({ place, repository }) => agents.newAgentBranches(place, repository),
      ListAgentModels: ({ engine, place }) => agents.models(engine, place),
      ListNewAgentCommands: ({ engine, place, repository }) =>
        agents.newAgentCommands(engine, place, repository),
      ListAgentCommands: ({ agentId }) => agents.commands(agentId),
      ListNewAgentFiles: ({ place, repository, baseBranch }) =>
        agents.newAgentFiles(place, repository, baseBranch),
      ListAgentFiles: ({ agentId }) => agents.files(agentId),
      ListSandboxProviders: () => Effect.succeed(sandboxes.providers),
      CreateAgent: (input) => agents.create(input),
      WatchWaitingAgents: () =>
        agents.watchWaiting().pipe(Stream.map((waiting) => waiting.map(({ agent }) => agent.id))),
      WatchNeedsYou: () => needsYou.watch(),
      ChangeAgentModel: ({ agentId, model, effort }) =>
        agents.changeModel(agentId, { model, effort }),
      ChangePermissionMode: ({ agentId, permissionMode }) =>
        agents.changePermissionMode(agentId, permissionMode),
      AnswerRequest: ({ agentId, requestId, answer }) => agents.answer(agentId, requestId, answer),
      SendMessage: ({ agentId, message, images, feedback }) =>
        agents.send(agentId, { message, images }, feedback).pipe(Effect.asVoid),
      Steer: ({ agentId, message, images }) => agents.steer(agentId, { message, images }),
      CancelQueuedMessage: ({ agentId, queuedMessageId }) =>
        agents.cancelQueued(agentId, queuedMessageId),
      SendQueuedMessage: ({ agentId, queuedMessageId }) =>
        agents.sendQueued(agentId, queuedMessageId),
      StopTurn: ({ agentId }) => agents.stop(agentId),
      ReachSandbox: ({ agentId }) => agents.reachSandbox(agentId),
      GetUnsentMessage: ({ agentId }) => agents.unsent(agentId),
      SaveUnsentMessage: ({ agentId, message, images }) =>
        agents.saveUnsent(agentId, { message, images }),
      GetAgentChanges: ({ agentId }) => agents.changes(agentId),
      ListFeedbackNotes: ({ agentId }) => agents.feedbackNotes(agentId),
      StageFeedbackNotes: ({ agentId }) => agents.stageFeedbackNotes(agentId),
      SaveFeedbackNote: ({ agentId, note }) => agents.saveFeedbackNote(agentId, note),
      RemoveFeedbackNote: ({ agentId, noteId }) => agents.removeFeedbackNote(agentId, noteId),
      GetRemovalWarnings: ({ agentId }) => agents.removalWarnings(agentId),
      RemoveAgent: ({ agentId }) => agents.remove(agentId),
      GetGlobalConversationModel: () => globalConversation.model,
      ChangeGlobalConversationModel: (choice) => globalConversation.changeModel(choice),
      WatchGlobalTranscript: () => globalConversation.transcript,
      SendGlobalMessage: (input) => globalConversation.send(input),
      SteerGlobal: (input) => globalConversation.steer(input),
      CancelGlobalQueuedMessage: ({ queuedMessageId }) =>
        globalConversation.cancelQueued(queuedMessageId),
      SendGlobalQueuedMessage: ({ queuedMessageId }) =>
        globalConversation.sendQueued(queuedMessageId),
      StopGlobalTurn: () => globalConversation.stop,
      AnswerGlobalRequest: ({ requestId, answer }) => globalConversation.answer(requestId, answer),
      GetGlobalUnsentMessage: () => globalConversation.unsent,
      SaveGlobalUnsentMessage: (unsent) => globalConversation.saveUnsent(unsent),
    })
  }),
)

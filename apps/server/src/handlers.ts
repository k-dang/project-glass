import { ActivityPullRequest, GlassRpcs, PullRequestOpened } from "@glass/contracts"
import { Effect } from "effect"
import { ActivityLog } from "./ActivityLog"
import { AgentReviews } from "./AgentReviews"
import { Asks } from "./Asks"
import { Agents } from "./Agents"
import { GitHubClient } from "./github/GitHubClient"
import { FollowedRepositories } from "./FollowedRepositories"
import { LocalCheckouts } from "./LocalCheckouts"
import { PullRequestLists } from "./PullRequestLists"
import { Queue } from "./Queue"
import { engineSettingsOf, SettingsStore, withEngineSettings } from "./SettingsStore"
import { Sandboxes } from "./Sandboxes"
import { SavedPlaces } from "./SavedPlaces"
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
    const settings = yield* SettingsStore
    const savedPlaces = yield* SavedPlaces
    const agents = yield* Agents
    const sandboxes = yield* Sandboxes
    const checkouts = yield* LocalCheckouts

    return GlassRpcs.of({
      GetSavedPlaces: () => savedPlaces.list(),
      SavePlace: ({ destination }) => savedPlaces.save(destination),
      WriteTour: ({ pullRequest, revision }) => tours.write(pullRequest, revision),
      CancelTour: ({ pullRequest }) => tours.cancel(pullRequest),
      WatchTour: ({ pullRequest }) => tours.watch(pullRequest),
      StartAgentReview: ({ pullRequest, revision }) => agentReviews.start(pullRequest, revision),
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
      GetQueueTours: () => queue.toursEnabled(),
      SetQueueTours: ({ enabled }) => queue.setToursEnabled(enabled),
      ListFollowedRepositories: () => repositories.list(),
      FollowRepository: ({ input }) => repositories.follow(input),
      UnfollowRepository: ({ repository }) => repositories.unfollow(repository),
      ListPullRequests: () => lists.list(),
      ListSavedPullRequests: () => lists.saved(),
      ListSavedQueue: () => queue.saved(),
      RefreshQueue: () => queue.refresh(),
      AddToQueue: ({ references }) => queue.add(references),
      RemoveFromQueue: ({ reference }) => queue.remove(reference),
      RestoreToQueue: ({ queued }) => queue.restore(queued),
      GetConnection: () => github.viewer,
      OpenPullRequest: ({ pullRequest: ref }) =>
        github.pullRequest(ref).pipe(
          Effect.tap(({ pullRequest, revision }) =>
            Effect.all([
              activityLog.record(
                PullRequestOpened.make({
                  pullRequest: new ActivityPullRequest({
                    ref: pullRequest.ref,
                    title: pullRequest.title,
                    revision,
                  }),
                }),
              ),
              queue.opened(pullRequest.ref),
            ]),
          ),
        ),
      HasPullRequestChanged: ({ pullRequestId, revision, updatedAt }) =>
        github.hasChanged(pullRequestId, revision, updatedAt),
      GetFileContents: ({ pullRequest, revision, side, path }) =>
        github.fileContents(pullRequest, revision, side, path),
      ListRepositoryFiles: ({ pullRequest, revision }) =>
        github.repositoryFiles(pullRequest, revision),
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
      RecordActivity: (activity) => activityLog.record(activity),
      ListActivity: ({ limit }) =>
        github.viewer.pipe(Effect.flatMap(({ login }) => activityLog.list(login, limit))),
      ListToDos: () => toDos.list(),
      AddToDo: ({ title }) => toDos.add(title),
      EditToDo: ({ id, title, notes }) => toDos.edit(id, title, notes),
      SetToDoDone: ({ id, done }) => toDos.setDone(id, done),
      DeleteToDo: ({ id }) => toDos.remove(id),
      WatchAgents: () => agents.watch(),
      WatchTranscript: ({ agentId }) => agents.transcript(agentId),
      ListLocalCheckouts: () => checkouts.list(),
      LinkLocalCheckout: ({ path }) => checkouts.link(path),
      ListBranches: ({ repository }) => checkouts.branches(repository),
      ListGitHubBranches: ({ repository }) => github.repositoryBranches(repository),
      ListAgentModels: ({ engine, place }) => agents.models(engine, place),
      ListSandboxProviders: () => Effect.succeed(sandboxes.providers),
      CreateAgent: (input) => agents.create(input),
      WatchWaitingAgents: () => agents.watchWaiting(),
      ChangeAgentModel: ({ agentId, model, effort }) =>
        agents.changeModel(agentId, { model, effort }),
      ChangePermissionMode: ({ agentId, permissionMode }) =>
        agents.changePermissionMode(agentId, permissionMode),
      AnswerRequest: ({ agentId, requestId, answer }) => agents.answer(agentId, requestId, answer),
      SendMessage: ({ agentId, message, images }) => agents.send(agentId, { message, images }),
      Steer: ({ agentId, message, images }) => agents.steer(agentId, { message, images }),
      CancelQueuedMessage: ({ agentId, queuedMessageId }) =>
        agents.cancelQueued(agentId, queuedMessageId),
      SendQueuedMessage: ({ agentId, queuedMessageId }) =>
        agents.sendQueued(agentId, queuedMessageId),
      StopTurn: ({ agentId }) => agents.stop(agentId),
      GetUnsentMessage: ({ agentId }) => agents.unsent(agentId),
      SaveUnsentMessage: ({ agentId, message, images }) =>
        agents.saveUnsent(agentId, { message, images }),
      GetAgentChanges: ({ agentId }) => agents.changes(agentId),
      GetRemovalWarnings: ({ agentId }) => agents.removalWarnings(agentId),
      RemoveAgent: ({ agentId }) => agents.remove(agentId),
    })
  }),
)

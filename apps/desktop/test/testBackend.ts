import {
  emptyTranscript,
  GlassRpcs,
  nothingUnsent,
  SavedPlace,
  TranscriptSnapshot,
  UnsentFeedback,
} from "@glass/contracts"
import { DateTime, Effect, Layer, ManagedRuntime, Stream } from "effect"
import { AtomRegistry } from "effect/reactivity"
import { type Rpc, type RpcGroup, RpcTest } from "effect/rpc"
import { expect } from "vite-plus/test"
import { eventually } from "./eventually"
import { Backend, backendLayerAtom } from "../src/renderer/backend"

export type Handlers = {
  readonly [Current in RpcGroup.Rpcs<typeof GlassRpcs> as Current["_tag"]]: Rpc.ToHandlerFn<
    Current,
    never
  >
}

const unused = () => Effect.die("The test doesn't expect this RPC")

export const testLayer = (handlers: Partial<Handlers>) =>
  Layer.effect(Backend, RpcTest.makeClient(GlassRpcs)).pipe(
    Layer.provide(
      GlassRpcs.toLayer<Handlers>({
        GetSavedPlaces: () => Effect.succeed([]),
        SavePlace: ({ destination }) =>
          DateTime.now.pipe(Effect.map((savedAt) => new SavedPlace({ destination, savedAt }))),
        WriteTour: unused,
        CancelTour: unused,
        WatchTour: () => Stream.make({ tour: null, job: { status: "idle" } }),
        StartAgentReview: unused,
        FollowUpAgentReview: unused,
        CancelAgentReview: unused,
        WatchAgentReview: () => Stream.make({ review: null, job: { status: "idle" } }),
        Ask: unused,
        GetReviewPrompt: unused,
        SetReviewPrompt: unused,
        GetEngineSettings: unused,
        SetEngineSettings: unused,
        GetQueueWork: () => Effect.succeed(false),
        SetQueueWork: unused,
        GetStorageBreakdown: () => Effect.succeed([]),
        ListFollowedRepositories: unused,
        FollowRepository: unused,
        UnfollowRepository: unused,
        ListSkillPacks: () => Effect.succeed([]),
        ListLocalSkills: () => Effect.succeed([]),
        PreviewSkillPack: unused,
        AddSkillPack: unused,
        PreviewSkillPackUpdate: unused,
        UpdateSkillPack: unused,
        RemoveSkillPack: unused,
        ListPullRequests: unused,
        ListSavedPullRequests: () => Effect.succeed(null),
        ListSavedQueue: () => Effect.succeed([]),
        RefreshQueue: () => Effect.void,
        AddToQueue: unused,
        RemoveFromQueue: unused,
        RestoreToQueue: unused,
        GetConnection: unused,
        OpenPullRequest: unused,
        HasPullRequestChanged: unused,
        GetFileContents: unused,
        ListRepositoryFiles: unused,
        SetFileViewed: unused,
        CreateDraft: unused,
        UpdateDraft: unused,
        DeleteDraft: unused,
        SubmitReview: unused,
        ReplyToDiscussion: unused,
        SetDiscussionResolved: unused,
        SetReaction: unused,
        RecordActivity: unused,
        ListActivity: unused,
        ListActivityStamps: () => Effect.succeed([]),
        ListToDos: () => Effect.succeed([]),
        AddToDo: unused,
        EditToDo: unused,
        SetToDoDone: unused,
        DeleteToDo: unused,
        WatchAgents: () => Stream.make([]),
        WatchWaitingAgents: () => Stream.make([]),
        WatchTranscript: unused,
        ListLocalCheckouts: () => Effect.succeed([]),
        LinkLocalCheckout: unused,
        GetNewAgentDefaultBranch: unused,
        ListNewAgentBranches: unused,
        ListAgentModels: unused,
        ListNewAgentCommands: () => Effect.succeed([]),
        ListAgentCommands: () => Effect.succeed([]),
        ListNewAgentFiles: () => Effect.succeed([]),
        ListAgentFiles: () => Effect.succeed([]),
        ListSandboxProviders: () => Effect.succeed([]),
        CreateAgent: unused,
        SendMessage: unused,
        GetAgentChanges: unused,
        ListFeedbackNotes: () => Effect.succeed(new UnsentFeedback({ notes: [], staged: [] })),
        StageFeedbackNotes: unused,
        SaveFeedbackNote: unused,
        RemoveFeedbackNote: unused,
        CancelQueuedMessage: unused,
        SendQueuedMessage: unused,
        StopTurn: unused,
        ReachSandbox: unused,
        Steer: unused,
        GetUnsentMessage: () => Effect.succeed(nothingUnsent),
        SaveUnsentMessage: () => Effect.void,
        ChangeAgentModel: unused,
        ChangePermissionMode: unused,
        AnswerRequest: unused,
        GetRemovalWarnings: unused,
        RemoveAgent: unused,
        GetGlobalConversationModel: () => Effect.succeed({ model: null, effort: null }),
        ChangeGlobalConversationModel: unused,
        WatchGlobalTranscript: () => Stream.make(TranscriptSnapshot.make(emptyTranscript)),
        SendGlobalMessage: unused,
        SteerGlobal: unused,
        CancelGlobalQueuedMessage: unused,
        SendGlobalQueuedMessage: unused,
        StopGlobalTurn: unused,
        AnswerGlobalRequest: unused,
        GetGlobalUnsentMessage: () => Effect.succeed(nothingUnsent),
        SaveGlobalUnsentMessage: () => Effect.void,
        ...handlers,
      }),
    ),
  )

export const testRuntime = (handlers: Partial<Handlers>) => ManagedRuntime.make(testLayer(handlers))

export const testRegistry = (handlers: Partial<Handlers>) =>
  AtomRegistry.make({ initialValues: [[backendLayerAtom, testLayer(handlers)]] })

export interface Held<P, A, E> {
  readonly payload: P
  readonly answer: (result: Effect.Effect<A, E>) => void
}

export const hold =
  <P, A, E>(queue: Array<Held<P, A, E>>) =>
  (payload: P) =>
    Effect.callback<A, E>((resume) => {
      queue.push({ payload, answer: resume })
    })

export const next = async <P, A, E>(queue: Array<Held<P, A, E>>) => {
  await eventually(() => expect(queue).not.toHaveLength(0))

  return queue.shift()!
}

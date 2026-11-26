import {
  emptyTranscript,
  GlassRpcs,
  Listed,
  noListings,
  nothingUnsent,
  SavedPlace,
  type ToDo,
  TranscriptSnapshot,
} from "@glass/contracts"
import {
  type Cause,
  DateTime,
  Deferred,
  Effect,
  Layer,
  ManagedRuntime,
  Queue,
  Stream,
} from "effect"
import { AtomRegistry } from "effect/reactivity"
import { Rpc, type RpcGroup, RpcTest } from "effect/rpc"
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

const settled = <A, E>(result: A | Deferred.Deferred<A, E>) =>
  Deferred.isDeferred<A, E>(result) ? Deferred.await(result) : Effect.succeed(result)

const watchedToDos = (
  handlers: Partial<Handlers>,
): Pick<Handlers, "WatchToDos"> & Partial<Handlers> => {
  const watchers = new Set<Queue.Queue<ReadonlyArray<ToDo>, Cause.Done>>()
  const { AddToDo, EditToDo, SetToDoDone, DeleteToDo, AttachToDoImages, RemoveToDoImage } = handlers

  const announce = <E>(
    saved: Rpc.WrapperOr<
      Effect.Effect<ReadonlyArray<ToDo> | Deferred.Deferred<ReadonlyArray<ToDo>, E>, E>
    >,
  ) =>
    Rpc.unwrap(saved).pipe(
      Effect.flatMap(settled),
      Effect.tap((toDos) =>
        Effect.sync(() => watchers.forEach((queue) => Queue.offerUnsafe(queue, toDos))),
      ),
    )

  return {
    WatchToDos: (payload, options) => {
      const given = handlers.WatchToDos && Rpc.unwrap(handlers.WatchToDos(payload, options))

      return Stream.concat(
        given === undefined ? Stream.make([]) : Stream.isStream(given) ? given : Stream.die(given),
        Stream.callback<ReadonlyArray<ToDo>>((queue) =>
          Effect.acquireRelease(
            Effect.sync(() => watchers.add(queue)),
            () => Effect.sync(() => watchers.delete(queue)),
          ),
        ),
      )
    },
    ...(AddToDo && { AddToDo: (...args) => announce(AddToDo(...args)) }),
    ...(EditToDo && { EditToDo: (...args) => announce(EditToDo(...args)) }),
    ...(SetToDoDone && { SetToDoDone: (...args) => announce(SetToDoDone(...args)) }),
    ...(DeleteToDo && { DeleteToDo: (...args) => announce(DeleteToDo(...args)) }),
    ...(AttachToDoImages && { AttachToDoImages: (...args) => announce(AttachToDoImages(...args)) }),
    ...(RemoveToDoImage && { RemoveToDoImage: (...args) => announce(RemoveToDoImage(...args)) }),
  }
}

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
        MarkAgentReviewDone: unused,
        WatchAgentReview: () => Stream.make({ review: null, job: { status: "idle" } }),
        Ask: unused,
        GetReviewPrompt: unused,
        SetReviewPrompt: unused,
        GetEngineSettings: unused,
        SetEngineSettings: unused,
        GetQueueWork: () => Effect.succeed(false),
        ReportRendererEvents: () => Effect.void,
        SetQueueWork: unused,
        GetStorageBreakdown: () => Effect.succeed([]),
        ListFollowedRepositories: () => Effect.succeed([]),
        FollowRepository: unused,
        UnfollowRepository: unused,
        ListSkillPacks: () => Effect.succeed([]),
        ListLocalSkills: () => Effect.succeed([]),
        PreviewSkillPack: unused,
        AddSkillPack: unused,
        PreviewSkillPackUpdate: unused,
        UpdateSkillPack: unused,
        RemoveSkillPack: unused,
        ListPullRequests: () => Effect.succeed(noListings),
        WatchPullRequests: () => Stream.make(Listed.make({ listings: noListings, problem: null })),
        ListSavedQueue: () => Effect.succeed([]),
        RefreshQueue: () => Effect.void,
        AddToQueue: unused,
        RemoveFromQueue: unused,
        RestoreToQueue: unused,
        GetConnection: unused,
        LoadPullRequest: unused,
        HasPullRequestChanged: unused,
        GetPullRequestStatus: () => Effect.never,
        GetFileContents: unused,
        ListRepositoryFiles: unused,
        SetFileViewed: unused,
        CreateDraft: unused,
        UpdateDraft: unused,
        DeleteDraft: unused,
        SubmitReview: unused,
        ReplyToReviewThread: unused,
        MergePullRequest: unused,
        SetReviewThreadResolved: unused,
        SetReaction: unused,
        RecordActivity: () => Effect.void,
        ListActivity: unused,
        ListActivityStamps: () => Effect.succeed([]),
        ListToDos: () => Effect.succeed([]),
        AddToDo: unused,
        EditToDo: unused,
        SetToDoDone: unused,
        DeleteToDo: unused,
        AttachToDoImages: unused,
        RemoveToDoImage: unused,
        ReadToDoImage: unused,
        WatchThreads: () => Stream.make([]),
        WatchWorkingThreads: () => Stream.make([]),
        WatchBrowserPageRequests: () => Stream.never,
        AnswerBrowserPageRequest: unused,
        WatchBrowserControl: () => Stream.make([]),
        TakeOverBrowser: unused,
        HandBackBrowser: unused,
        WatchSettledThreads: () => Stream.make([]),
        BringBackThread: unused,
        WatchThreadPullRequests: () => Stream.make([]),
        WatchInbox: () => Stream.make([]),
        MarkTurnSeen: () => Effect.void,
        WatchTranscript: unused,
        LoadEarlierTurns: unused,
        ListLocalCheckouts: () => Effect.succeed([]),
        LinkLocalCheckout: unused,
        GetNewThreadDefaultBranch: unused,
        ListNewThreadBranches: unused,
        ListAgentModels: unused,
        ListNewThreadCommands: () => Effect.succeed([]),
        ListThreadCommands: () => Effect.succeed([]),
        ListNewThreadFiles: () => Effect.succeed([]),
        ListThreadFiles: () => Effect.succeed([]),
        FindThreadFiles: () => Effect.succeed([]),
        GetThreadFile: unused,
        ListSandboxProviders: () => Effect.succeed([]),
        CreateThread: unused,
        SendMessage: unused,
        GetThreadChanges: unused,
        ListFeedbackNotes: () => Effect.succeed([]),
        SaveFeedbackNote: unused,
        RemoveFeedbackNote: unused,
        CancelQueuedMessage: unused,
        SendQueuedMessage: unused,
        StopTurn: unused,
        StopBackgroundTask: unused,
        ReachSandbox: unused,
        Steer: unused,
        GetUnsentMessage: () => Effect.succeed(nothingUnsent),
        SaveUnsentMessage: () => Effect.void,
        ChangeThreadModel: unused,
        ChangePermissionMode: unused,
        AnswerRequest: unused,
        AnswerOutsideQuestion: unused,
        GetCheckInChanges: unused,
        ListCheckInNotes: unused,
        SaveCheckInNote: unused,
        RemoveCheckInNote: unused,
        AnswerCheckIn: unused,
        GetMcpEndpoint: () => Effect.succeed({ url: "http://127.0.0.1:0/mcp" }),
        WatchOutsideAgents: () => Stream.make([]),
        AnswerOutsideAgentRequest: unused,
        RevokeOutsideAgent: unused,
        GetRemovalWarnings: unused,
        RemoveThread: unused,
        GetGlobalChatModel: () => Effect.succeed({ model: null, effort: null }),
        ChangeGlobalChatModel: unused,
        WatchGlobalTranscript: () => Stream.make(TranscriptSnapshot.make(emptyTranscript)),
        LoadEarlierGlobalTurns: unused,
        SendGlobalMessage: unused,
        SteerGlobal: unused,
        CancelGlobalQueuedMessage: unused,
        SendGlobalQueuedMessage: unused,
        StopGlobalTurn: unused,
        AnswerGlobalRequest: unused,
        GetGlobalUnsentMessage: () => Effect.succeed(nothingUnsent),
        SaveGlobalUnsentMessage: () => Effect.void,
        WatchGlobalUnseen: () => Stream.make(null),
        MarkGlobalTurnSeen: () => Effect.void,
        StartGlobalChatFresh: unused,
        ListEndedGlobalChatSessions: () => Effect.succeed([]),
        WatchGlobalChatSession: unused,
        LoadEarlierGlobalChatSessionTurns: unused,
        ...handlers,
        ...watchedToDos(handlers),
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

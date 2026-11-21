import {
  ThreadContext,
  type ThreadMessageInput,
  type CapturedContext,
  type MessageInput,
  type ModelChoice,
  PullRequestContext,
  type PullRequestRef,
  type RequestAnswer,
} from "@glass/contracts"
import { Data, type DateTime, Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { threadsAtom, noCommands, noFiles, TRANSCRIPT_IDLE_TTL, transcriptOf } from "./threadsArea"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import type { ThreadAtoms } from "./thread"
import { openWorkspaceAtom, sameRef } from "./reviewsArea"

export const globalChatOpenAtom = Atom.make(false).pipe(Atom.keepAlive)

export const globalUnseenAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalUnseen())))
  .pipe(Atom.keepAlive)

export const markGlobalTurnSeenAtom = backendRuntime.fn((endedAt: DateTime.Utc) =>
  Backend.use((backend) => backend.MarkGlobalTurnSeen({ endedAt })),
)

export const globalModelAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetGlobalChatModel()))
  .pipe(Atom.keepAlive)

export const changeGlobalModelAtom = backendRuntime.fn((choice: ModelChoice, get) =>
  Backend.use((backend) => backend.ChangeGlobalChatModel(choice)).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(globalModelAtom))),
  ),
)

export const endedSessionsAtom = backendRuntime.atom(
  Backend.use((backend) => backend.ListEndedGlobalChatSessions()),
)

export const sessionTranscriptAtom = Atom.family((id: string) =>
  backendRuntime.atom(
    transcriptOf(
      Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalChatSession({ id }))),
    ),
  ),
)

export const loadEarlierInSessionAtom = Atom.family((id: string) =>
  backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierGlobalChatSessionTurns({ id, before })),
  ),
)

export const startGlobalFreshAtom = backendRuntime.fn((_: void, get) =>
  Backend.use((backend) => backend.StartGlobalChatFresh()).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(endedSessionsAtom))),
  ),
)

export type Viewed = Data.TaggedEnum<{
  PullRequest: { readonly ref: PullRequestRef }
  Thread: { readonly threadId: string }
}>

export const Viewed = Data.taggedEnum<Viewed>()

export const viewedAtom = Atom.make<Viewed | null>(null).pipe(Atom.keepAlive)

export const capturedContextAtom = Atom.make((get): CapturedContext | null => {
  const viewed = get(viewedAtom)

  if (viewed === null) return null

  return Viewed.$match(viewed, {
    PullRequest: ({ ref }) => {
      const workspace = Option.getOrNull(AsyncResult.value(get(openWorkspaceAtom)))?.workspace

      return workspace === undefined || !sameRef(workspace.pullRequest.ref, ref)
        ? null
        : PullRequestContext.make({
            pullRequest: workspace.pullRequest.ref,
            revision: workspace.revision,
          })
    },
    Thread: ({ threadId }) => {
      const thread = Option.getOrNull(AsyncResult.value(get(threadsAtom)))?.find(
        ({ id }) => id === threadId,
      )

      return thread === undefined
        ? null
        : ThreadContext.make({ threadId: thread.id, name: thread.name })
    },
  })
})

const sending = ({ message, images }: MessageInput, get: Atom.FnContext) => ({
  message,
  images,
  context: get(capturedContextAtom),
})

export const globalChat: ThreadAtoms = {
  composerKey: "global-chat",
  transcript: backendRuntime
    .atom(
      transcriptOf(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalTranscript()))),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
  loadEarlier: backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierGlobalTurns({ before })),
  ),
  send: backendRuntime.fn((sent: ThreadMessageInput, get) =>
    Backend.use((backend) => backend.SendGlobalMessage(sending(sent, get))),
  ),
  steer: backendRuntime.fn((sent: MessageInput, get) =>
    Backend.use((backend) => backend.SteerGlobal(sending(sent, get))),
  ),
  stop: backendRuntime.fn(() => Backend.use((backend) => backend.StopGlobalTurn())),
  cancelQueued: backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.CancelGlobalQueuedMessage({ queuedMessageId })),
  ),
  sendQueued: backendRuntime.fn((queuedMessageId: string) =>
    Backend.use((backend) => backend.SendGlobalQueuedMessage({ queuedMessageId })),
  ),
  answer: Atom.family((requestId: string) =>
    backendRuntime.fn((answer: RequestAnswer) =>
      Backend.use((backend) => backend.AnswerGlobalRequest({ requestId, answer })),
    ),
  ),
  unsent: backendRuntime.atom(Backend.use((backend) => backend.GetGlobalUnsentMessage())),
  saveUnsent: (registry, composed) =>
    void backendRuntimeOf(registry).runPromiseExit(
      Backend.use((backend) => backend.SaveGlobalUnsentMessage(composed)),
    ),
  commands: Atom.make(noCommands),
  files: Atom.make(noFiles),
}

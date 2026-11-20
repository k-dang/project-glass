import {
  ConversationContext,
  type ConversationMessageInput,
  type CapturedContext,
  type MessageInput,
  type ModelChoice,
  PullRequestContext,
  type PullRequestRef,
  type RequestAnswer,
} from "@glass/contracts"
import { Data, type DateTime, Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  conversationsAtom,
  noCommands,
  noFiles,
  TRANSCRIPT_IDLE_TTL,
  transcriptOf,
} from "./conversationsArea"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import type { ConversationAtoms } from "./conversation"
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

export const pastChatsAtom = backendRuntime.atom(Backend.use((backend) => backend.ListPastChats()))

export const pastGlobalTranscriptAtom = Atom.family((id: string) =>
  backendRuntime.atom(
    transcriptOf(Stream.unwrap(Backend.useSync((backend) => backend.WatchPastChat({ id })))),
  ),
)

export const loadEarlierPastTurnsAtom = Atom.family((id: string) =>
  backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierPastGlobalTurns({ id, before })),
  ),
)

export const startGlobalFreshAtom = backendRuntime.fn((_: void, get) =>
  Backend.use((backend) => backend.StartGlobalChatFresh()).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(pastChatsAtom))),
  ),
)

export type Viewed = Data.TaggedEnum<{
  PullRequest: { readonly ref: PullRequestRef }
  Conversation: { readonly conversationId: string }
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
    Conversation: ({ conversationId }) => {
      const conversation = Option.getOrNull(AsyncResult.value(get(conversationsAtom)))?.find(
        ({ id }) => id === conversationId,
      )

      return conversation === undefined
        ? null
        : ConversationContext.make({ conversationId: conversation.id, name: conversation.name })
    },
  })
})

const sending = ({ message, images }: MessageInput, get: Atom.FnContext) => ({
  message,
  images,
  context: get(capturedContextAtom),
})

export const globalChat: ConversationAtoms = {
  composerKey: "global-chat",
  transcript: backendRuntime
    .atom(
      transcriptOf(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalTranscript()))),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
  loadEarlier: backendRuntime.fn((before: string) =>
    Backend.use((backend) => backend.LoadEarlierGlobalTurns({ before })),
  ),
  send: backendRuntime.fn((sent: ConversationMessageInput, get) =>
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

import type { GlobalConversationProgram, MessageInput, RequestAnswer } from "@glass/contracts"
import { Effect, Stream } from "effect"
import { Atom } from "effect/reactivity"
import { noCommands, noFiles, TRANSCRIPT_IDLE_TTL, transcriptOf } from "./agentsArea"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import type { Conversation } from "./conversation"

export const globalConversationOpenAtom = Atom.make(false).pipe(Atom.keepAlive)

export const globalProgramAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetGlobalConversationProgram()))
  .pipe(Atom.keepAlive)

export const changeGlobalProgramAtom = backendRuntime.fn(
  (program: typeof GlobalConversationProgram.Encoded, get) =>
    Backend.use((backend) => backend.ChangeGlobalConversationProgram(program)).pipe(
      Effect.tap(() => Effect.sync(() => get.refresh(globalProgramAtom))),
    ),
)

const sending = (sent: MessageInput) => ({ ...sent, context: null })

export const globalConversation: Conversation = {
  composerKey: "global-conversation",
  transcript: backendRuntime
    .atom(
      transcriptOf(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalTranscript()))),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
  send: backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.SendGlobalMessage(sending(sent))),
  ),
  steer: backendRuntime.fn((sent: MessageInput) =>
    Backend.use((backend) => backend.SteerGlobal(sending(sent))),
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

import type {
  AgentCommand,
  ThreadMessageInput,
  MessageInput,
  RequestAnswer,
  SentMessage,
  Transcript,
} from "@glass/contracts"
import type { Cause } from "effect"
import type { Atom, AsyncResult, AtomRegistry } from "effect/reactivity"
import { createContext, useContext } from "react"
import {
  ThreadRequest,
  threadCommandsAtom,
  threadFilesAtom,
  answerRequestAtom,
  cancelQueuedAtom,
  saveUnsent,
  sendMessageAtom,
  sendQueuedAtom,
  steerAtom,
  loadEarlierTurnsAtom,
  stopTurnAtom,
  transcriptAtom,
  unsentMessageAtom,
} from "./threadsArea"
import type { BackendError } from "./backend"

export interface ThreadAtoms {
  readonly composerKey: string
  readonly transcript: Atom.Atom<
    AsyncResult.AsyncResult<Transcript, BackendError | Cause.NoSuchElementError>
  >
  readonly loadEarlier: Atom.AtomResultFn<string, void, BackendError>
  readonly send: Atom.AtomResultFn<ThreadMessageInput, void, BackendError>
  readonly steer: Atom.AtomResultFn<MessageInput, void, BackendError>
  readonly stop: Atom.AtomResultFn<void, void, BackendError>
  readonly cancelQueued: Atom.AtomResultFn<string, void, BackendError>
  readonly sendQueued: Atom.AtomResultFn<string, void, BackendError>
  readonly answer: (requestId: string) => Atom.AtomResultFn<RequestAnswer, void, BackendError>
  readonly unsent: Atom.Atom<AsyncResult.AsyncResult<SentMessage, BackendError>>
  readonly saveUnsent: (registry: AtomRegistry.AtomRegistry, composed: SentMessage) => void
  readonly commands: Atom.Atom<ReadonlyArray<AgentCommand>>
  readonly files: Atom.Atom<ReadonlyArray<string>>
}

export const threadAtoms = (threadId: string): ThreadAtoms => ({
  composerKey: threadId,
  transcript: transcriptAtom(threadId),
  loadEarlier: loadEarlierTurnsAtom(threadId),
  send: sendMessageAtom(threadId),
  steer: steerAtom(threadId),
  stop: stopTurnAtom(threadId),
  cancelQueued: cancelQueuedAtom(threadId),
  sendQueued: sendQueuedAtom(threadId),
  answer: (requestId) => answerRequestAtom(new ThreadRequest({ threadId, requestId })),
  unsent: unsentMessageAtom(threadId),
  saveUnsent: (registry, composed) => saveUnsent(registry, threadId, composed),
  commands: threadCommandsAtom(threadId),
  files: threadFilesAtom(threadId),
})

export const ThreadAtomsContext = createContext<ThreadAtoms | null>(null)

export const useThreadAtoms = () => {
  const atoms = useContext(ThreadAtomsContext)

  if (atoms === null) throw new Error("A transcript needs a ThreadAtomsContext above it")

  return atoms
}

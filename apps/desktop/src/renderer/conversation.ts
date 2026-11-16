import type {
  AgentCommand,
  ConversationMessageInput,
  MessageInput,
  RequestAnswer,
  SentMessage,
  Transcript,
} from "@glass/contracts"
import type { Cause } from "effect"
import type { Atom, AsyncResult, AtomRegistry } from "effect/reactivity"
import { createContext, useContext } from "react"
import {
  ConversationRequest,
  conversationCommandsAtom,
  conversationFilesAtom,
  answerRequestAtom,
  cancelQueuedAtom,
  saveUnsent,
  sendMessageAtom,
  sendQueuedAtom,
  steerAtom,
  stopTurnAtom,
  transcriptAtom,
  unsentMessageAtom,
} from "./conversationsArea"
import type { BackendError } from "./backend"

export interface ConversationAtoms {
  readonly composerKey: string
  readonly transcript: Atom.Atom<
    AsyncResult.AsyncResult<Transcript, BackendError | Cause.NoSuchElementError>
  >
  readonly send: Atom.AtomResultFn<ConversationMessageInput, void, BackendError>
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

export const conversationAtoms = (conversationId: string): ConversationAtoms => ({
  composerKey: conversationId,
  transcript: transcriptAtom(conversationId),
  send: sendMessageAtom(conversationId),
  steer: steerAtom(conversationId),
  stop: stopTurnAtom(conversationId),
  cancelQueued: cancelQueuedAtom(conversationId),
  sendQueued: sendQueuedAtom(conversationId),
  answer: (requestId) => answerRequestAtom(new ConversationRequest({ conversationId, requestId })),
  unsent: unsentMessageAtom(conversationId),
  saveUnsent: (registry, composed) => saveUnsent(registry, conversationId, composed),
  commands: conversationCommandsAtom(conversationId),
  files: conversationFilesAtom(conversationId),
})

export const ConversationAtomsContext = createContext<ConversationAtoms | null>(null)

export const useConversationAtoms = () => {
  const atoms = useContext(ConversationAtomsContext)

  if (atoms === null) throw new Error("A transcript needs a ConversationAtomsContext above it")

  return atoms
}

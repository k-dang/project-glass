import type {
  AgentCommand,
  MessageInput,
  RequestAnswer,
  SentMessage,
  Transcript,
} from "@glass/contracts"
import type { Cause } from "effect"
import type { Atom, AsyncResult, AtomRegistry } from "effect/reactivity"
import { createContext, useContext } from "react"
import {
  AgentRequest,
  agentCommandsAtom,
  agentFilesAtom,
  answerRequestAtom,
  cancelQueuedAtom,
  saveUnsent,
  sendMessageAtom,
  sendQueuedAtom,
  steerAtom,
  stopTurnAtom,
  transcriptAtom,
  unsentMessageAtom,
} from "./agentsArea"
import type { BackendError } from "./backend"

/**
 * Everything a transcript and its composer read and do, for an Agent or the Global conversation.
 * Its atoms come from families, so the same conversation always gets the same ones.
 */
export interface Conversation {
  /** Keys what the user is writing, kept apart for each conversation. */
  readonly key: string
  readonly transcript: Atom.Atom<
    AsyncResult.AsyncResult<Transcript, BackendError | Cause.NoSuchElementError>
  >
  readonly send: Atom.AtomResultFn<MessageInput, void, BackendError>
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

export const agentConversation = (agentId: string): Conversation => ({
  key: agentId,
  transcript: transcriptAtom(agentId),
  send: sendMessageAtom(agentId),
  steer: steerAtom(agentId),
  stop: stopTurnAtom(agentId),
  cancelQueued: cancelQueuedAtom(agentId),
  sendQueued: sendQueuedAtom(agentId),
  answer: (requestId) => answerRequestAtom(new AgentRequest({ agentId, requestId })),
  unsent: unsentMessageAtom(agentId),
  saveUnsent: (registry, composed) => saveUnsent(registry, agentId, composed),
  commands: agentCommandsAtom(agentId),
  files: agentFilesAtom(agentId),
})

export const ConversationContext = createContext<Conversation | null>(null)

export const useConversation = () => {
  const conversation = useContext(ConversationContext)

  if (conversation === null) throw new Error("A transcript needs a ConversationContext above it")

  return conversation
}

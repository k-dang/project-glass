import {
  AgentContext,
  type AgentMessageInput,
  type CapturedContext,
  type MessageInput,
  type ModelChoice,
  PullRequestContext,
  type PullRequestRef,
  type RequestAnswer,
} from "@glass/contracts"
import { Data, type DateTime, Effect, Option, Stream } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { agentsAtom, noCommands, noFiles, TRANSCRIPT_IDLE_TTL, transcriptOf } from "./agentsArea"
import { Backend, backendRuntime, backendRuntimeOf } from "./backend"
import type { Conversation } from "./conversation"
import { openWorkspaceAtom, sameRef } from "./reviewsArea"

export const globalConversationOpenAtom = Atom.make(false).pipe(Atom.keepAlive)

export const globalUnseenAtom = backendRuntime
  .atom(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalUnseen())))
  .pipe(Atom.keepAlive)

export const markGlobalTurnSeenAtom = backendRuntime.fn((endedAt: DateTime.Utc) =>
  Backend.use((backend) => backend.MarkGlobalTurnSeen({ endedAt })),
)

export const globalModelAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetGlobalConversationModel()))
  .pipe(Atom.keepAlive)

export const changeGlobalModelAtom = backendRuntime.fn((choice: ModelChoice, get) =>
  Backend.use((backend) => backend.ChangeGlobalConversationModel(choice)).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(globalModelAtom))),
  ),
)

export const pastGlobalConversationsAtom = backendRuntime.atom(
  Backend.use((backend) => backend.ListPastGlobalConversations()),
)

export const pastGlobalTranscriptAtom = Atom.family((id: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.ReadPastGlobalConversation({ id }))),
)

export const startGlobalFreshAtom = backendRuntime.fn((_: void, get) =>
  Backend.use((backend) => backend.StartGlobalConversationFresh()).pipe(
    Effect.tap(() => Effect.sync(() => get.refresh(pastGlobalConversationsAtom))),
  ),
)

/** The PR workspace or Agent the current route shows, which the router keeps up to date. */
export type Viewed = Data.TaggedEnum<{
  PullRequest: { readonly ref: PullRequestRef }
  Agent: { readonly agentId: string }
}>

export const Viewed = Data.taggedEnum<Viewed>()

export const viewedAtom = Atom.make<Viewed | null>(null).pipe(Atom.keepAlive)

/** What a message sent now carries: the PR at the Revision on screen, or the Agent on screen. */
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
    Agent: ({ agentId }) => {
      const agent = Option.getOrNull(AsyncResult.value(get(agentsAtom)))?.find(
        ({ id }) => id === agentId,
      )

      return agent === undefined ? null : AgentContext.make({ agentId: agent.id, name: agent.name })
    },
  })
})

const sending = ({ message, images }: MessageInput, get: Atom.FnContext) => ({
  message,
  images,
  context: get(capturedContextAtom),
})

export const globalConversation: Conversation = {
  composerKey: "global-conversation",
  transcript: backendRuntime
    .atom(
      transcriptOf(Stream.unwrap(Backend.useSync((backend) => backend.WatchGlobalTranscript()))),
    )
    .pipe(Atom.setIdleTTL(TRANSCRIPT_IDLE_TTL)),
  send: backendRuntime.fn((sent: AgentMessageInput, get) =>
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

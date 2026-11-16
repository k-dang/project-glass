import { Effect } from "effect"
import { AgentHostRpcs } from "./protocol"
import { Changes } from "./Changes"
import { HostConversations } from "./HostConversations"
import { Journal } from "./Journal"

export const AgentHostHandlers = AgentHostRpcs.toLayer(
  Effect.gen(function* () {
    const conversations = yield* HostConversations
    const journal = yield* Journal
    const changes = yield* Changes

    return AgentHostRpcs.of({
      ListModels: ({ harness }) => conversations.models(harness),
      ListCommands: ({ harness, folder, skills }) =>
        conversations.commands(harness, folder, skills),
      StartConversation: (start) => conversations.start(start),
      StartTurn: ({ conversationId, turnId, model, effort, permissionMode, ...message }) =>
        conversations.startTurn(conversationId, turnId, message, { model, effort, permissionMode }),
      Steer: ({ conversationId, ...message }) => conversations.steer(conversationId, message),
      StopTurn: ({ conversationId, turnId }) => conversations.stopTurn(conversationId, turnId),
      AnswerRequest: ({ conversationId, requestId, answer }) =>
        conversations.answer(conversationId, requestId, answer),
      StopConversation: ({ conversationId }) => conversations.stop(conversationId),
      GetChanges: ({ folder, baseRef }) => changes.since(folder, baseRef),
      HasUncommittedChanges: ({ folder }) => changes.uncommitted(folder),
      ListFiles: ({ folder }) => changes.files(folder),
      WatchJournal: ({ after }) => journal.watch(after),
      Acknowledge: ({ through }) => journal.acknowledge(through),
    })
  }),
)

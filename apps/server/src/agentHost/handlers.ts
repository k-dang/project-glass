import { Effect } from "effect"
import { AgentHostRpcs, failure, HOST_PROTOCOL } from "./protocol"
import { Changes } from "../Changes"
import { FolderFiles } from "./FolderFiles"
import { HostGlassTools } from "./HostGlassTools"
import { HostConversations } from "./HostConversations"
import { Journal } from "./Journal"

export const AgentHostHandlers = AgentHostRpcs.toLayer(
  Effect.gen(function* () {
    const conversations = yield* HostConversations
    const journal = yield* Journal
    const changes = yield* Changes
    const folderFiles = yield* FolderFiles
    const glassTools = yield* HostGlassTools

    return AgentHostRpcs.of({
      Hello: () => Effect.succeed({ host: journal.host, protocol: HOST_PROTOCOL }),
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
      GetChanges: ({ folder, baseRef }) =>
        changes.since(folder, baseRef).pipe(failure("Couldn't read the Conversation's changes.")),
      HasUncommittedChanges: ({ folder }) =>
        changes
          .uncommitted(folder)
          .pipe(failure("Couldn't check the Conversation's folder for changes.")),
      CurrentBranch: ({ folder }) =>
        changes.branch(folder).pipe(failure("Couldn't read the Conversation's branch.")),
      ListFiles: ({ folder }) =>
        changes
          .files(folder)
          .pipe(failure("Couldn't list the files in the Conversation's folder.")),
      ExistingFiles: ({ folder, paths }) => folderFiles.existing(folder, paths),
      ReadFile: ({ folder, path }) => folderFiles.read(folder, path),
      WatchJournal: ({ host, after }) => journal.watch(host, after),
      Acknowledge: ({ host, through }) => journal.acknowledge(host, through),
      UnacknowledgedTurns: () => conversations.unacknowledgedTurns,
      OfferGlassTools: ({ host, tools }) => glassTools.offer(host, tools),
      WatchToolCalls: ({ host }) => glassTools.watch(host),
      AnswerToolCall: ({ host, callId, result }) => glassTools.answer(host, callId, result),
    })
  }),
)

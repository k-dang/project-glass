import { Effect } from "effect"
import { AgentHostRpcs, failure, HOST_PROTOCOL } from "./protocol"
import { Changes } from "../Changes"
import { FolderFiles } from "./FolderFiles"
import { HostGlassTools } from "./HostGlassTools"
import { HostThreads } from "./HostThreads"
import { Journal } from "./Journal"

export const AgentHostHandlers = AgentHostRpcs.toLayer(
  Effect.gen(function* () {
    const threads = yield* HostThreads
    const journal = yield* Journal
    const changes = yield* Changes
    const folderFiles = yield* FolderFiles
    const glassTools = yield* HostGlassTools

    return AgentHostRpcs.of({
      Hello: () => Effect.succeed({ host: journal.host, protocol: HOST_PROTOCOL }),
      ListModels: ({ harness }) => threads.models(harness),
      ListCommands: ({ harness, folder, role, skills }) =>
        threads.commands(harness, folder, role, skills),
      StartThread: (start) => threads.start(start),
      StartTurn: ({ threadId, turnId, model, effort, permissionMode, ...message }) =>
        threads.startTurn(threadId, turnId, message, { model, effort, permissionMode }),
      Steer: ({ threadId, ...message }) => threads.steer(threadId, message),
      StopTurn: ({ threadId, turnId }) => threads.stopTurn(threadId, turnId),
      StopBackgroundTask: ({ threadId, taskId }) => threads.stopBackgroundTask(threadId, taskId),
      AnswerRequest: ({ threadId, requestId, answer }) =>
        threads.answer(threadId, requestId, answer),
      StopThread: ({ threadId }) => threads.stop(threadId),
      GetChanges: ({ folder, baseRef }) =>
        changes.since(folder, baseRef).pipe(failure("Couldn't read the Thread's changes.")),
      HasUncommittedChanges: ({ folder }) =>
        changes
          .uncommitted(folder)
          .pipe(failure("Couldn't check the Thread's folder for changes.")),
      CurrentBranch: ({ folder }) =>
        changes.branch(folder).pipe(failure("Couldn't read the Thread's branch.")),
      ListFiles: ({ folder }) =>
        changes.files(folder).pipe(failure("Couldn't list the files in the Thread's folder.")),
      ExistingFiles: ({ folder, paths }) => folderFiles.existing(folder, paths),
      ReadFile: ({ folder, path }) => folderFiles.read(folder, path),
      WatchJournal: ({ host, after }) => journal.watch(host, after),
      Acknowledge: ({ host, through }) => journal.acknowledge(host, through),
      UnacknowledgedTurns: () => threads.unacknowledgedTurns,
      OfferGlassTools: ({ host, tools }) => glassTools.offer(host, tools),
      WatchToolCalls: ({ host }) => glassTools.watch(host),
      AnswerToolCall: ({ host, callId, result }) => glassTools.answer(host, callId, result),
    })
  }),
)

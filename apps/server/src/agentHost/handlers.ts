import { Effect } from "effect"
import { AgentHostRpcs } from "./protocol"
import { Changes } from "./Changes"
import { HostAgents } from "./HostAgents"
import { Journal } from "./Journal"

export const AgentHostHandlers = AgentHostRpcs.toLayer(
  Effect.gen(function* () {
    const agents = yield* HostAgents
    const journal = yield* Journal
    const changes = yield* Changes

    return AgentHostRpcs.of({
      ListModels: ({ engine }) => agents.models(engine),
      StartAgent: ({ agentId, engine, folder }) => agents.start(agentId, engine, folder),
      StartTurn: ({ agentId, turnId, message, images, ...settings }) =>
        agents.startTurn(agentId, turnId, { message, images }, settings),
      Steer: ({ agentId, message, images }) => agents.steer(agentId, { message, images }),
      StopTurn: ({ agentId }) => agents.stopTurn(agentId),
      AnswerRequest: ({ agentId, requestId, answer }) => agents.answer(agentId, requestId, answer),
      StopAgent: ({ agentId }) => agents.stop(agentId),
      GetChanges: ({ folder, baseRef }) => changes.since(folder, baseRef),
      HasUncommittedChanges: ({ folder }) => changes.uncommitted(folder),
      WatchJournal: ({ after }) => journal.watch(after),
      Acknowledge: ({ through }) => journal.acknowledge(through),
    })
  }),
)

import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type AgentDestination, repositoryKey } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { Sparkles } from "lucide-react"
import { agentsAtom, engineNames, machineNames } from "./agentsArea"
import { ContinueCard, rememberPlaceHint } from "./ContinueCard"
import { Empty } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"

export function AgentContinueCard(props: { destination: AgentDestination }) {
  const result = useAtomValue(agentsAtom)
  const retry = useAtomRefresh(agentsAtom)

  return AsyncResult.builder(result)
    .onSuccess((agents) => {
      const agent = agents.find(({ id }) => id === props.destination.agentId)

      return agent === undefined ? (
        <Empty title="Your last Agent is gone">{rememberPlaceHint}</Empty>
      ) : (
        <ContinueCard
          link={{ to: "/agents/$agentId", params: { agentId: agent.id } }}
          name={agent.name}
          icon={Sparkles}
          subtitle={`Agents · ${repositoryKey(agent.repository)} · ${engineNames[agent.engine]} · ${machineNames[agent.place._tag]}`}
        />
      )
    })
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Try again", run: retry }} />
    ))
    .orElse(() => (
      <output className="py-6 text-sm text-muted-foreground">Loading your Agents…</output>
    ))
}

import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type AgentDestination, repositoryKey } from "@glass/contracts"
import { AsyncResult } from "effect/reactivity"
import { Sparkles } from "lucide-react"
import { agentsAtom, placeNames } from "./agentsArea"
import { engineNames } from "./engines"
import { ContinueCard, ContinueInvitation } from "./ContinueCard"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"

function AgentInvitation(props: { title: string }) {
  return (
    <ContinueInvitation
      link={{ to: "/agents/new" }}
      icon={Sparkles}
      title={props.title}
      hint="Start an Agent and Glass will remember your place."
      action="Start an Agent"
    />
  )
}

export function AgentContinueCard(props: { destination: AgentDestination | undefined }) {
  return props.destination === undefined ? (
    <AgentInvitation title="No Agent yet" />
  ) : (
    <LastAgent destination={props.destination} />
  )
}

function LastAgent(props: { destination: AgentDestination }) {
  const result = useAtomValue(agentsAtom)
  const retry = useAtomRefresh(agentsAtom)

  return AsyncResult.builder(result)
    .onSuccess((agents) => {
      const agent = agents.find(({ id }) => id === props.destination.agentId)

      return agent === undefined ? (
        <AgentInvitation title="Your last Agent is gone" />
      ) : (
        <ContinueCard
          link={{ to: "/agents/$agentId", params: { agentId: agent.id } }}
          name={agent.name}
          icon={Sparkles}
          subtitle={`Agents · ${repositoryKey(agent.repository)} · ${engineNames[agent.engine]} · ${placeNames[agent.place._tag]}`}
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

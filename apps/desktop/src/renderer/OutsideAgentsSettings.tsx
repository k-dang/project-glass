import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { OutsideAgent } from "@glass/contracts"
import { DateTime, Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Button } from "@/components/ui/button"
import { Backend, backendRuntime } from "./backend"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf, settledProblem } from "./problems"
import { SettingsSection } from "./SettingsSection"

const endpointAtom = backendRuntime
  .atom(Backend.use((backend) => backend.GetMcpEndpoint()))
  .pipe(Atom.keepAlive)

const listedAtom = backendRuntime
  .atom(Backend.use((backend) => backend.ListOutsideAgents()))
  .pipe(Atom.keepAlive)

const revokeAtom = backendRuntime
  .fn((id: string) => Backend.use((backend) => backend.RevokeOutsideAgent({ id })))
  .pipe(Atom.keepAlive)

const agentsAtom = Atom.make((get) =>
  Option.match(AsyncResult.value(get(revokeAtom)), {
    onSome: (agents) => AsyncResult.success(agents),
    onNone: () => get(listedAtom),
  }),
)

const connectedUntil = (agent: OutsideAgent) => DateTime.formatIsoDateUtc(agent.expiresAt)

export function OutsideAgentsSettings() {
  const endpoint = useAtomValue(endpointAtom)
  const agents = useAtomValue(agentsAtom)
  const revoke = useAtomValue(revokeAtom)
  const disconnect = useAtomSet(revokeAtom)
  const problem = settledProblem(revoke)

  return (
    <SettingsSection
      title="Outside agents"
      description="Agents you approved to use Glass's MCP tools on this computer. Revoking one signs it out."
    >
      {AsyncResult.builder(endpoint)
        .onInitialOrWaiting(() => (
          <p className="text-sm text-muted-foreground">Loading the MCP address…</p>
        ))
        .onFailure((cause) => <ProblemAlert problem={problemOf(cause)} />)
        .onSuccess(({ url }) => (
          <p className="text-sm">
            MCP address <code className="break-all">{url}</code>
          </p>
        ))
        .render()}
      {AsyncResult.builder(agents)
        .onInitialOrWaiting(() => (
          <p className="text-sm text-muted-foreground">Loading outside agents…</p>
        ))
        .onFailure((cause) => <ProblemAlert problem={problemOf(cause)} />)
        .onSuccess((connected) =>
          connected.length === 0 ? (
            <p className="text-sm text-muted-foreground">No outside agents are connected.</p>
          ) : (
            <ul className="divide-y text-sm">
              {connected.map((agent) => (
                <li key={agent.id} className="flex items-center justify-between gap-6 py-3">
                  <span>
                    {agent.name}
                    <span className="mt-1 block text-muted-foreground">
                      Connected until {connectedUntil(agent)}
                    </span>
                  </span>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={revoke.waiting}
                    onClick={() => disconnect(agent.id)}
                  >
                    {revoke.waiting ? "Revoking…" : "Revoke"}
                  </Button>
                </li>
              ))}
            </ul>
          ),
        )
        .render()}
      {problem === null ? null : <ProblemAlert problem={problem} />}
    </SettingsSection>
  )
}

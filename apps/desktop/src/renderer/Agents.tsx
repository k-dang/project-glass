import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { type Agent, repositoryKey } from "@glass/contracts"
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { Exit, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { FolderGit2, SquarePen, Trash2 } from "lucide-react"
import { useContext, useEffect, useEffectEvent, useId, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { TooltipHint } from "@/components/ui/tooltip"
import {
  agentsAtom,
  groupAgents,
  machineNames,
  removalWarningsAtom,
  removeAgent,
  waitingAgentsAtom,
} from "./agentsArea"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { settledProblem, streamProblem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"
import { shortcutLabel } from "./shortcutLabel"

const noneWaiting: ReadonlySet<string> = new Set()

const agentLink =
  "flex flex-col gap-0.5 rounded-md py-1.5 pr-8 pl-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"

export function AgentsLayout() {
  return (
    <main aria-label="Agents" className="flex min-h-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col gap-4 overflow-y-auto border-r px-3 py-4">
        <div className="flex items-center justify-between pl-2">
          <h1 className="text-sm font-semibold">Agents</h1>
          <NewAgentLink />
        </div>
        <AgentList />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </main>
  )
}

function NewAgentLink() {
  const navigate = useNavigate()

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    const inDialog =
      event.target instanceof Element && event.target.closest("[role=dialog]") !== null

    if (
      inDialog ||
      event.key.toLowerCase() !== "n" ||
      !(event.metaKey || event.ctrlKey) ||
      event.shiftKey ||
      event.altKey
    )
      return

    event.preventDefault()
    void navigate({ to: "/agents/new" })
  })

  useEffect(() => {
    window.addEventListener("keydown", onShortcut)

    return () => window.removeEventListener("keydown", onShortcut)
  }, [])

  return (
    <TooltipHint
      content={
        <span className="flex items-center gap-2">
          New Agent <Kbd>{shortcutLabel("N")}</Kbd>
        </span>
      }
      side="bottom"
    >
      <Link
        to="/agents/new"
        aria-label="New Agent"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <SquarePen aria-hidden />
      </Link>
    </TooltipHint>
  )
}

function AgentList() {
  const agents = useAtomValue(agentsAtom)
  const retry = useAtomRefresh(agentsAtom)

  return AsyncResult.builder(agents)
    .onInitial(() => (
      <output className="px-2 text-sm text-muted-foreground">Loading Agents…</output>
    ))
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Retry", run: retry }} />
    ))
    .onSuccess((list) =>
      list.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">No Agents yet.</p>
      ) : (
        <nav aria-label="Agents list" className="flex flex-col gap-4">
          {groupAgents(list).map(({ machine, agents: onMachine }) => (
            <section
              key={machine}
              aria-label={machineNames[machine]}
              className="flex flex-col gap-1"
            >
              <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {machineNames[machine]}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {onMachine.map((agent) => (
                  <AgentRow key={agent.id} agent={agent} />
                ))}
              </ul>
            </section>
          ))}
        </nav>
      ),
    )
    .render()
}

const removalWarning = (agent: Agent, warning: "some" | "unchecked") => {
  const inSandbox = Predicate.isTagged(agent.place, "sandbox")

  if (warning === "unchecked")
    return inSandbox
      ? "Glass couldn't reach its Sandbox to check for uncommitted changes. Removing it deletes the Sandbox and everything in it."
      : `Glass couldn't check its worktree for uncommitted changes. Removing it discards any. The branch ${agent.name} and its commits stay.`

  return inSandbox
    ? "Its Sandbox has uncommitted changes, which removing it discards along with the Sandbox."
    : `Its worktree has uncommitted changes, which removing it discards. The branch ${agent.name} and its commits stay.`
}

function AgentRow(props: { agent: Agent }) {
  const { agent } = props
  const navigate = useNavigate()
  const open = useParams({ strict: false }).agentId === agent.id
  const registry = useContext(RegistryContext)
  const warnings = useAtomValue(removalWarningsAtom(agent.id))
  const checkWarnings = useAtomSet(removalWarningsAtom(agent.id), { mode: "promiseExit" })
  const [confirming, setConfirming] = useState<"some" | "unchecked" | null>(null)
  const problem = settledProblem(warnings)
  const repositoryId = useId()
  const waitingId = useId()

  const waiting = Option.getOrElse(
    AsyncResult.value(useAtomValue(waitingAgentsAtom)),
    () => noneWaiting,
  ).has(agent.id)

  const removeNow = () => {
    setConfirming(null)

    if (open) void navigate({ to: "/agents" })

    void removeAgent(registry, agent)
  }

  const start = async () => {
    const exit = await checkWarnings()

    if (Exit.isFailure(exit)) return

    const { uncommittedChanges } = exit.value

    if (uncommittedChanges === "none") removeNow()
    else setConfirming(uncommittedChanges)
  }

  return (
    <li className="group/row relative">
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.id }}
        aria-label={agent.name}
        aria-describedby={waiting ? `${repositoryId} ${waitingId}` : repositoryId}
        className={agentLink}
      >
        <span
          id={repositoryId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <FolderGit2 aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{repositoryKey(agent.repository)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{agent.name}</span>
          {waiting && (
            <span
              id={waitingId}
              className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              Waiting on you
            </span>
          )}
        </span>
      </Link>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${agent.name}`}
        disabled={warnings.waiting}
        onClick={() => void start()}
        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 aria-hidden />
      </Button>
      {problem !== null && (
        <p role="alert" className="px-2 pt-0.5 text-xs text-destructive">
          {problem.detail}
        </p>
      )}
      <ConfirmationDialog
        open={confirming !== null}
        title={`Remove ${agent.name}?`}
        description={confirming === null ? "" : removalWarning(agent, confirming)}
        confirmLabel="Remove Agent"
        onConfirm={removeNow}
        onCancel={() => setConfirming(null)}
      />
    </li>
  )
}

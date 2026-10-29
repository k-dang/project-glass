import { cn } from "cn"
import { Cause, Option } from "effect"
import { Copy, KeyRound, LoaderCircle, RefreshCw, TriangleAlert, WifiOff } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { toast } from "@/components/ui/toast"
import type { BackendError } from "./backend"
import { withCode } from "./ProblemAlert"
import { problemOf } from "./problems"

function ProblemIcon(props: { error: BackendError | null }) {
  switch (props.error?._tag) {
    case "NoCredentials":
    case "TokenRejected":
      return <KeyRound className="size-5" aria-hidden />
    case "GitHubUnavailable":
      return <WifiOff className="size-5" aria-hidden />
    default:
      return <TriangleAlert className="size-5" aria-hidden />
  }
}

const copy = async (command: string) => {
  try {
    await navigator.clipboard.writeText(command)
    toast.add({ type: "success", title: "Command copied", timeout: 2500 })
  } catch {
    toast.add({ type: "error", title: "Couldn't copy to the clipboard" })
  }
}

function ConnectionCard(props: {
  alert?: boolean
  icon: ReactNode
  tone: string
  title: string
  detail: ReactNode
  children?: ReactNode
}) {
  const Region = props.alert ? "section" : "output"

  return (
    <div className="flex flex-1 items-center justify-center px-6 pt-8 pb-24">
      <Region
        role={props.alert ? "alert" : undefined}
        aria-labelledby="connection-card"
        className="flex w-full max-w-md flex-col gap-4"
      >
        <div className={cn("grid size-10 place-items-center rounded-lg", props.tone)}>
          {props.icon}
        </div>
        <div className="space-y-1">
          <h1 id="connection-card" className="text-lg font-semibold">
            {props.title}
          </h1>
          <p className="text-sm text-muted-foreground">{props.detail}</p>
        </div>
        {props.children}
      </Region>
    </div>
  )
}

export function Connecting() {
  return (
    <ConnectionCard
      icon={<LoaderCircle className="size-5 animate-spin motion-reduce:animate-none" aria-hidden />}
      tone="bg-muted text-muted-foreground"
      title="Connecting to GitHub"
      detail="Glass signs in with the token you already have. This usually takes a second."
    />
  )
}

export function ConnectionProblem(props: {
  cause: Cause.Cause<BackendError>
  checking: boolean
  onRetry: () => void
}) {
  const error = Option.getOrNull(Cause.findErrorOption(props.cause))
  const problem = problemOf(props.cause)
  const { command } = problem

  return (
    <ConnectionCard
      alert
      icon={<ProblemIcon error={error} />}
      tone="bg-destructive/10 text-destructive"
      title={problem.title}
      detail={withCode(problem.detail)}
    >
      {command !== undefined && (
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted py-1.5 pr-1.5 pl-3">
          <code className="overflow-x-auto font-mono text-sm whitespace-nowrap">{command}</code>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Copy ${command}`}
            onClick={() => void copy(command)}
          >
            <Copy aria-hidden />
            Copy
          </Button>
        </div>
      )}
      <div>
        <Button disabled={props.checking} focusableWhenDisabled onClick={props.onRetry}>
          {props.checking ? (
            <LoaderCircle className="animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <RefreshCw aria-hidden />
          )}
          {props.checking ? "Checking…" : "Try again"}
        </Button>
      </div>
    </ConnectionCard>
  )
}

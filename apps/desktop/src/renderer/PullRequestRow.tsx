import type { Checks, PullRequestRef, PullRequestState, PullRequestSummary } from "@glass/contracts"
import { cn } from "cn"
import { DateTime } from "effect"
import {
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  History,
  type LucideIcon,
} from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger, TooltipHint } from "@/components/ui/tooltip"
import { type Problem, problemText } from "./problems"

export const warningTone = "text-amber-600 dark:text-amber-400"

export function NotRefreshed(props: { problem: Problem; showLabel?: boolean }) {
  const reason = problemText(props.problem)

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0 items-center gap-1.5" />}>
        <History className={cn("size-3.5", warningTone)} aria-hidden />
        <span className={props.showLabel ? undefined : "sr-only"}>Not refreshed</span>
        <span className="sr-only">: {reason}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

export const columnsWithRepository =
  "grid-cols-[0_1rem_minmax(0,1fr)_fit-content(9rem)_3.5rem_7rem_2rem_0]"

export const columns = "grid-cols-[0_1rem_minmax(0,1fr)_3.5rem_7rem_2rem_0]"

// The Queue's extra column, beside the checks icon, holds each row's `lead`.
export const queueColumns =
  "grid-cols-[0_1rem_1rem_minmax(0,1fr)_fit-content(9rem)_3.5rem_7rem_2rem_0]"

export const subgridRow = "col-span-full grid grid-cols-subgrid"

export const repositoryLabeller = (
  repositories: ReadonlyArray<{ owner: string; repo: string }>,
) => {
  const distinct = new Set(repositories.map(({ owner, repo }) => `${owner}/${repo}`.toLowerCase()))
  const sharingName = Map.groupBy(distinct, (key) => key.split("/")[1])

  return ({ owner, repo }: PullRequestRef) =>
    (sharingName.get(repo.toLowerCase())?.length ?? 0) > 1 ? `${owner}/${repo}` : repo
}

export function PullRequestRow(props: {
  pullRequest: PullRequestSummary
  state?: PullRequestState
  dimmed: boolean
  marker?: ReactNode
  lead?: ReactNode
  notRefreshed?: Problem | undefined
  now: Date
  repository?: string
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const { pullRequest } = props
  const statusId = useId()
  const [statusHintOpen, setStatusHintOpen] = useState(false)

  const { owner, repo, number } = pullRequest.ref

  const updated = DateTime.toDateUtc(pullRequest.updatedAt)

  const checks = checksLabels[pullRequest.checks]
  const finished = finishedStates[props.state ?? "open"]
  const status = finished ?? checks
  const label = finished?.label ?? `Checks ${checks.label}`

  const StatusIcon = status.icon

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => props.onOpen(pullRequest.ref)}
      onFocus={(event) => {
        if (event.target === event.currentTarget) setStatusHintOpen(true)
      }}
      onBlur={() => setStatusHintOpen(false)}
      className={cn(
        subgridRow,
        "h-9 gap-2.5 px-0 text-left motion-safe:active:not-focus-visible:scale-100 font-normal hover:bg-muted/50 active:bg-muted",
      )}
    >
      {props.marker}
      <Tooltip open={statusHintOpen} onOpenChange={setStatusHintOpen} triggerId={statusId}>
        <TooltipTrigger id={statusId} render={<span aria-hidden className="col-start-2" />}>
          <StatusIcon className={cn("size-4", status.tone)} />
        </TooltipTrigger>
        <TooltipContent>{finished?.label ?? `Checks ${checks.label.toLowerCase()}`}</TooltipContent>
      </Tooltip>
      {props.lead !== undefined && <span className="flex items-center">{props.lead}</span>}
      <span className="flex min-w-0 items-center gap-2.5 overflow-hidden">
        <TooltipHint content={pullRequest.title}>
          <span className={cn("min-w-0 truncate font-medium", props.dimmed && "opacity-55")}>
            {pullRequest.title}
          </span>
        </TooltipHint>
        {props.notRefreshed !== undefined && <NotRefreshed problem={props.notRefreshed} />}
        {pullRequest.isDraft && (
          <Badge
            variant="outline"
            className="h-auto rounded border-dashed border-muted-foreground px-1.5 py-0 text-muted-foreground"
          >
            Draft PR
          </Badge>
        )}
      </span>
      {props.repository !== undefined && (
        <TooltipHint content={`${owner}/${repo}`}>
          <span className="truncate text-xs text-foreground/70">{props.repository}</span>
        </TooltipHint>
      )}
      <span className="text-right text-xs text-muted-foreground tabular-nums">#{number}</span>
      <TooltipHint content={pullRequest.author}>
        <span className="truncate text-xs text-muted-foreground">{pullRequest.author}</span>
      </TooltipHint>
      <TooltipHint content={`Updated ${updated.toLocaleString()}`}>
        <time
          dateTime={updated.toISOString()}
          className="text-right text-xs text-muted-foreground tabular-nums"
        >
          {ago(updated, props.now)}
        </time>
      </TooltipHint>
      <span className="sr-only">{label}</span>
    </Button>
  )
}

const finishedStates: Partial<
  Record<
    PullRequestState,
    { readonly label: string; readonly icon: LucideIcon; readonly tone: string }
  >
> = {
  merged: { label: "Merged", icon: GitMerge, tone: "text-violet-600 dark:text-violet-400" },
  closed: { label: "Closed", icon: GitPullRequestClosed, tone: "text-red-600 dark:text-red-400" },
}

const checksLabels: Record<
  Checks,
  {
    readonly label: string
    readonly icon: LucideIcon
    readonly tone: string
  }
> = {
  passing: { label: "Passing", icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  failing: { label: "Failing", icon: CircleX, tone: "text-red-600 dark:text-red-400" },
  running: { label: "Running", icon: CircleDotDashed, tone: warningTone },
  unavailable: { label: "Unavailable", icon: CircleDashed, tone: "text-muted-foreground/60" },
}

const ago = (date: Date, now: Date) => {
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000)

  if (minutes < 1) return "now"

  if (minutes < 60) return `${minutes}m`

  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`

  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d`

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

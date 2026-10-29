import { TooltipHint } from "@/components/ui/tooltip"
import type {
  Approval,
  Check,
  CheckState,
  PullRequest,
  Reviewer,
  ReviewerState,
} from "@glass/contracts"
import { cn } from "cn"
import {
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleMinus,
  CircleX,
  FileDiff,
  type LucideIcon,
  TriangleAlert,
  Users,
} from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"

const warningTone = "text-amber-600 dark:text-amber-400"

interface Summary {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
}

const approved: Summary = { label: "Approved", icon: CircleCheck, tone: "text-added" }

const changesRequested: Summary = {
  label: "Changes requested",
  icon: FileDiff,
  tone: "text-deleted",
}

const approvalSummaries: Record<Approval, Summary> = {
  approved,
  "changes-requested": changesRequested,
  "review-required": { label: "Review required", icon: Users, tone: warningTone },
}

const reviewersSummary = (reviewers: ReadonlyArray<Reviewer>): Summary => {
  const has = (state: ReviewerState) => reviewers.some((r) => r.state === state)

  if (has("changes-requested")) return changesRequested

  if (has("approved")) return approved

  if (has("requested")) return { label: "Review requested", icon: Users, tone: warningTone }

  return { label: "No reviews", icon: Users, tone: "text-muted-foreground" }
}

const checksSummary = (checks: ReadonlyArray<Check>): Summary => {
  const count = (state: CheckState) => checks.filter((check) => check.state === state).length

  if (checks.length === 0)
    return { label: "No checks", icon: CircleDashed, tone: "text-muted-foreground" }

  if (count("failed") > 0) return { ...checkStates.failed, label: `${count("failed")} failing` }

  if (count("running") > 0) return { ...checkStates.running, label: `${count("running")} running` }

  return { ...checkStates.passed, label: "Checks passed" }
}

const reviewerStates: Record<ReviewerState, Summary> = {
  approved,
  "changes-requested": changesRequested,
  requested: { label: "Awaiting review", icon: CircleDotDashed, tone: warningTone },
}

const checkStates: Record<CheckState, Summary> = {
  failed: { label: "Failed", icon: CircleX, tone: "text-deleted" },
  running: { label: "Running", icon: CircleDotDashed, tone: warningTone },
  passed: { label: "Passed", icon: CircleCheck, tone: "text-added" },
  skipped: { label: "Skipped", icon: CircleMinus, tone: "text-muted-foreground" },
}

const checkOrder: ReadonlyArray<CheckState> = ["failed", "running", "passed", "skipped"]

export const isOpen = (pullRequest: PullRequest) =>
  pullRequest.state === "open" || pullRequest.state === "draft"

export function StatusChips(props: { pullRequest: PullRequest }) {
  const { pullRequest } = props

  const checks = pullRequest.checks.toSorted(
    (a, b) => checkOrder.indexOf(a.state) - checkOrder.indexOf(b.state),
  )

  const open = isOpen(pullRequest)

  return (
    <>
      <StatusChip
        summary={
          pullRequest.approval === null
            ? reviewersSummary(pullRequest.reviewers)
            : approvalSummaries[pullRequest.approval]
        }
        title="Reviewers"
        details={
          pullRequest.reviewers.length === 0 ? null : (
            <ReviewerList reviewers={pullRequest.reviewers} />
          )
        }
      />
      <StatusChip
        summary={checksSummary(checks)}
        title="Checks"
        details={checks.length === 0 ? null : <CheckList checks={checks} />}
      />
      {open && <ConflictsChip pullRequest={pullRequest} />}
    </>
  )
}

const chipClass = "h-6 gap-1 rounded-full px-2 text-xs font-normal text-foreground"

function StatusChip(props: { summary: Summary; title: string; details: ReactNode | null }) {
  const { label, icon: Icon, tone } = props.summary

  const content = (
    <>
      <Icon aria-hidden className={cn("size-3.5", tone)} />
      {label}
    </>
  )

  if (props.details === null) {
    return (
      <span className={cn("inline-flex items-center border border-transparent", chipClass)}>
        {content}
      </span>
    )
  }

  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="xs" className={chipClass} />}>
        {content}
        <ChevronDown aria-hidden className="size-3 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 gap-1 p-1.5">
        <PopoverTitle className="px-1.5 pt-1 text-xs text-muted-foreground">
          {props.title}
        </PopoverTitle>
        {props.details}
      </PopoverContent>
    </Popover>
  )
}

function StateIcon(props: { state: Summary }) {
  const { label, icon: Icon, tone } = props.state

  return (
    <span className={cn("flex shrink-0 items-center gap-1 text-xs", tone)}>
      <Icon aria-hidden className="size-3.5" />
      {label}
    </span>
  )
}

function ReviewerList(props: { reviewers: ReadonlyArray<Reviewer> }) {
  return (
    <ul className="flex flex-col">
      {props.reviewers.map((reviewer) => (
        <li key={reviewer.name} className="flex items-center gap-2 rounded-md px-1.5 py-1">
          <span className="min-w-0 flex-1 truncate font-medium">{reviewer.name}</span>
          <StateIcon state={reviewerStates[reviewer.state]} />
        </li>
      ))}
    </ul>
  )
}

function CheckList(props: { checks: ReadonlyArray<Check> }) {
  return (
    <ul className="flex max-h-80 flex-col overflow-y-auto">
      {props.checks.map((check, index) => {
        const { label, icon: Icon, tone } = checkStates[check.state]

        const row = (
          <>
            <Icon aria-label={label} className={cn("size-3.5 shrink-0", tone)} />
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{check.name}</span>
          </>
        )

        return (
          <li key={`${check.name}-${index}`}>
            {check.url === null ? (
              <div className="flex items-center gap-2 px-1.5 py-1">{row}</div>
            ) : (
              <TooltipHint content={`Open ${check.name} on GitHub`}>
                <a
                  href={check.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                >
                  {row}
                </a>
              </TooltipHint>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function ConflictsChip(props: { pullRequest: PullRequest }) {
  const { mergeable, baseBranch } = props.pullRequest

  const {
    label,
    icon: Icon,
    tone,
    title,
  } = {
    mergeable: {
      label: "No conflicts",
      icon: CircleCheck,
      tone: "text-added",
      title: `No conflicts with ${baseBranch}`,
    },
    conflicting: {
      label: "Conflicts",
      icon: TriangleAlert,
      tone: "text-deleted",
      title: `Conflicts with ${baseBranch} that must be resolved before merging`,
    },
    checking: {
      label: "Checking conflicts",
      icon: CircleDashed,
      tone: "text-muted-foreground",
      title: `GitHub was still checking for conflicts with ${baseBranch}. Reload to see the result.`,
    },
  }[mergeable]

  return (
    <TooltipHint content={title}>
      <span className={cn("inline-flex items-center border border-transparent", chipClass)}>
        <Icon aria-hidden className={cn("size-3.5", tone)} />
        {label}
      </span>
    </TooltipHint>
  )
}

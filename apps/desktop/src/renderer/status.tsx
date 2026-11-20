import type { Checks, PullRequestState } from "@glass/contracts"
import { cn } from "cn"
import {
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleX,
  GitMerge,
  GitPullRequestClosed,
  type LucideIcon,
} from "lucide-react"

export const warningTone = "text-amber-600 dark:text-amber-400"

export interface StatusLabel {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
}

export const checksLabels: Record<Checks, StatusLabel> = {
  passing: { label: "Passing", icon: CircleCheck, tone: "text-emerald-600 dark:text-emerald-400" },
  failing: { label: "Failing", icon: CircleX, tone: "text-red-600 dark:text-red-400" },
  running: { label: "Running", icon: CircleDotDashed, tone: warningTone },
  unavailable: { label: "Unavailable", icon: CircleDashed, tone: "text-muted-foreground/60" },
}

export const mergedLabel: StatusLabel = {
  label: "Merged",
  icon: GitMerge,
  tone: "text-violet-600 dark:text-violet-400",
}

export const closedLabel: StatusLabel = {
  label: "Closed",
  icon: GitPullRequestClosed,
  tone: "text-red-600 dark:text-red-400",
}

export const finishedStates: Partial<Record<PullRequestState, StatusLabel>> = {
  merged: mergedLabel,
  closed: closedLabel,
}

export function StatusIcon(props: { status: StatusLabel; className: string }) {
  const { icon: Icon, tone } = props.status

  return <Icon aria-hidden className={cn(props.className, tone)} />
}

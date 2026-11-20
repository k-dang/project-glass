import type { Checks, TurnEnding } from "@glass/contracts"
import { cn } from "cn"
import {
  CircleCheck,
  CircleDashed,
  CircleDotDashed,
  CircleStop,
  CircleX,
  type LucideIcon,
} from "lucide-react"

export const warningTone = "text-amber-600 dark:text-amber-400"

export const checksLabels: Record<
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

export const turnEndingLooks: Record<
  TurnEnding["_tag"],
  {
    readonly label: string
    readonly icon: LucideIcon
    readonly tone: string
  }
> = {
  Done: { label: "Finished", icon: CircleCheck, tone: "text-added" },
  Failed: { label: "Failed", icon: CircleX, tone: "text-deleted" },
  CutOff: { label: "Cut off", icon: CircleX, tone: "text-deleted" },
  Stopped: { label: "Stopped", icon: CircleStop, tone: "text-muted-foreground" },
  Interrupted: { label: "Interrupted", icon: CircleStop, tone: "text-muted-foreground" },
}

export function ChecksIcon(props: { checks: Checks; className: string }) {
  const { icon: Icon, tone } = checksLabels[props.checks]

  return <Icon aria-hidden className={cn(props.className, tone)} />
}

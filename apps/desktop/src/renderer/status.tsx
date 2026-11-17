import type { Checks } from "@glass/contracts"
import { cn } from "cn"
import { CircleCheck, CircleDashed, CircleDotDashed, CircleX, type LucideIcon } from "lucide-react"

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

export function ChecksIcon(props: { checks: Checks; className: string }) {
  const { icon: Icon, tone } = checksLabels[props.checks]

  return <Icon aria-hidden className={cn(props.className, tone)} />
}

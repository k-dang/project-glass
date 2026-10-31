import { useAtomValue } from "@effect/atom-react"
import type { QueuedPullRequest, Revision, TourState } from "@glass/contracts"
import { cn } from "cn"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Clock, LoaderCircle, type LucideIcon, Route, TriangleAlert } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { warningTone } from "./PullRequestRow"
import { isOutdated, tourStates } from "./useTour"

interface TourStatus {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
  readonly spinning?: boolean
  readonly detail?: string
}

const tourStatus = (state: TourState, revision: Revision | null): TourStatus | null => {
  const { tour, job } = state

  if (job.status === "waiting")
    return { label: "Tour waiting", icon: Clock, tone: "text-muted-foreground" }

  if (job.status === "writing")
    return {
      label: "Writing Tour",
      icon: LoaderCircle,
      tone: "text-muted-foreground",
      spinning: true,
    }

  if (job.status === "failed")
    return {
      label: "Tour failed",
      icon: TriangleAlert,
      tone: "text-destructive",
      detail: job.reason.message,
    }

  if (tour === null) return null

  return revision !== null && isOutdated(tour, revision)
    ? { label: "Tour outdated", icon: Route, tone: warningTone }
    : { label: "Tour ready", icon: Route, tone: "text-foreground/70" }
}

export function QueueTourStatus(props: { queued: QueuedPullRequest }) {
  const state = Option.getOrNull(
    AsyncResult.value(useAtomValue(tourStates(props.queued.pullRequest.ref))),
  )

  const status = state === null ? null : tourStatus(state, props.queued.revision)

  if (status === null) return null

  const Icon = status.icon
  const text = status.detail === undefined ? status.label : `${status.label}: ${status.detail}`

  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("flex items-center", status.tone)} />}>
        <Icon
          aria-hidden
          className={cn("size-3.5", status.spinning && "animate-spin motion-reduce:animate-none")}
        />
        <span className="sr-only">{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

import { useAtomValue } from "@effect/atom-react"
import {
  type AgentReviewState,
  finishedReview,
  type QueuedPullRequest,
  type Revision,
  type TourState,
} from "@glass/contracts"
import { cn } from "cn"
import { Equal, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  Clock,
  LoaderCircle,
  type LucideIcon,
  Route,
  ScanSearch,
  TriangleAlert,
} from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { warningTone } from "./PullRequestRow"
import { agentReviewStates } from "./useAgentReview"
import { tourStates } from "./useTour"

interface WorkStatus {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
  readonly spinning?: boolean
  readonly detail?: string
}

const waiting = (label: string): WorkStatus => ({
  label,
  icon: Clock,
  tone: "text-muted-foreground",
})

const running = (label: string): WorkStatus => ({
  label,
  icon: LoaderCircle,
  tone: "text-muted-foreground",
  spinning: true,
})

const failed = (label: string, detail: string): WorkStatus => ({
  label,
  icon: TriangleAlert,
  tone: "text-destructive",
  detail,
})

const writtenStatus = (
  label: string,
  icon: LucideIcon,
  writtenFor: Revision,
  current: Revision | null,
): WorkStatus =>
  current !== null && !Equal.equals(writtenFor, current)
    ? { label: `${label} outdated`, icon, tone: warningTone }
    : { label: `${label} ready`, icon, tone: "text-foreground/70" }

const tourStatus = ({ tour, job }: TourState, revision: Revision | null) => {
  if (job.status === "waiting") return waiting("Tour waiting")

  if (job.status === "writing") return running("Writing Tour")

  if (job.status === "failed") return failed("Tour failed", job.reason.message)

  return tour === null ? null : writtenStatus("Tour", Route, tour.revision, revision)
}

const agentReviewStatus = (state: AgentReviewState, revision: Revision | null) => {
  const { job } = state

  if (job.status === "waiting") return waiting("Agent review waiting")

  if (job.status === "reviewing") return running("Agent reviewing")

  if (job.status === "failed") return failed("Agent review failed", job.reason.message)

  const review = finishedReview(state)

  return review === null
    ? null
    : writtenStatus("Agent review", ScanSearch, review.revision, revision)
}

function StatusIcon(props: { status: WorkStatus | null }) {
  const { status } = props

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

export function QueueWorkStatus(props: { queued: QueuedPullRequest }) {
  const { pullRequest, revision } = props.queued
  const tour = Option.getOrNull(AsyncResult.value(useAtomValue(tourStates(pullRequest.ref))))

  const agentReview = Option.getOrNull(
    AsyncResult.value(useAtomValue(agentReviewStates(pullRequest.ref))),
  )

  return (
    <>
      <StatusIcon status={tour === null ? null : tourStatus(tour, revision)} />
      <StatusIcon status={agentReview === null ? null : agentReviewStatus(agentReview, revision)} />
    </>
  )
}

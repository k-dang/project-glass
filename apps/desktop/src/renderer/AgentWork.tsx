import { cn } from "cn"
import {
  Clock,
  LoaderCircle,
  type LucideIcon,
  RotateCw,
  Route,
  ScanSearch,
  Sparkles,
  Square,
  TriangleAlert,
} from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TooltipHint } from "@/components/ui/tooltip"
import { closedReason, failureOf } from "./AgentReviewCard"
import { Elapsed } from "./Elapsed"
import { plural } from "./plural"
import { warningTone } from "./PullRequestRow"
import { ShortSha } from "./shortSha"
import type { TourReading } from "./tourReading"
import type { AgentReviewControls } from "./useAgentReview"
import type { useTour } from "./useTour"

type Status =
  | { readonly type: "idle" }
  | { readonly type: "waiting" }
  | { readonly type: "running"; readonly startedAt: number }
  | { readonly type: "failed"; readonly message: string }

type AgentJob = {
  readonly name: "Tour" | "Agent review"
  readonly icon: LucideIcon
  readonly status: Status
  readonly saved: { readonly summary: string; readonly outdatedHead: string | null } | null
  readonly closed: string | null
  readonly start: { readonly label: string; readonly run: () => void } | null
  readonly cancel: () => void
  readonly read: () => void
}

const shortNames = { Tour: "Tour", "Agent review": "Review" } as const

const statusOf = (
  lost: string | null,
  startedAt: number | null,
  waiting: boolean,
  failure: string | null,
): Status => {
  if (lost !== null) return { type: "failed", message: lost }

  if (startedAt !== null) return { type: "running", startedAt }

  if (waiting) return { type: "waiting" }

  return failure === null ? { type: "idle" } : { type: "failed", message: failure }
}

const startOf = (
  status: Status,
  saved: boolean,
  reconnect: (() => void) | null,
  run: (() => void) | null,
  [first, again]: readonly [string, string],
) => {
  if (reconnect !== null) return { label: "Reconnect", run: reconnect }

  if (run === null) return null

  return { label: status.type === "failed" ? "Try again" : saved ? again : first, run }
}

const tourJob = (
  tour: ReturnType<typeof useTour>,
  reading: TourReading | null,
  onRead: () => void,
): AgentJob => {
  const job = tour.latest?.job

  const status = statusOf(
    tour.subscriptionProblem?.detail ?? null,
    job?.status === "writing" ? job.startedAt : null,
    job?.status === "waiting",
    tour.commandFailure?.problem.detail ?? (job?.status === "failed" ? job.reason.message : null),
  )

  return {
    name: "Tour",
    icon: Route,
    status,
    saved: reading && {
      summary: plural(reading.chapters.length, "Chapter"),
      outdatedHead: tour.outdated?.head ?? null,
    },
    closed: null,
    start: startOf(
      status,
      reading !== null,
      tour.subscriptionProblem === null ? null : tour.reconnect,
      tour.latest === null || tour.pending ? null : tour.write,
      ["Write", "Rewrite"],
    ),
    cancel: tour.cancel,
    read: onRead,
  }
}

const reviewJob = (controls: AgentReviewControls, onRead: () => void): AgentJob => {
  const { job, review, subscriptionProblem } = controls

  const status = statusOf(
    subscriptionProblem?.detail ?? null,
    job?.status === "reviewing" ? job.startedAt : null,
    job?.status === "waiting",
    failureOf(controls),
  )

  return {
    name: "Agent review",
    icon: ScanSearch,
    status,
    saved: review && {
      summary: "Ready",
      outdatedHead: controls.outdated ? review.revision.head : null,
    },
    closed: controls.closedAs && closedReason(controls.closedAs),
    start: startOf(
      status,
      review !== null,
      subscriptionProblem === null ? null : controls.reconnect,
      controls.start,
      ["Start", "Review again"],
    ),
    cancel: controls.cancel,
    read: onRead,
  }
}

const busy = (job: AgentJob) => job.status.type === "running" || job.status.type === "waiting"

function Spinner(props: { className: string }) {
  return (
    <LoaderCircle
      aria-hidden
      className={cn("shrink-0 animate-spin motion-reduce:animate-none", props.className)}
    />
  )
}

function Summary(props: { jobs: ReadonlyArray<AgentJob> }) {
  const running = props.jobs.flatMap((job) =>
    job.status.type === "running" ? [{ job, startedAt: job.status.startedAt }] : [],
  )

  const failed = props.jobs.find((job) => job.status.type === "failed")
  const [only] = running

  if (running.length === 1 && only !== undefined)
    return (
      <>
        <Spinner className="size-3.5" />
        {shortNames[only.job.name]}
        <Elapsed startedAt={only.startedAt} />
      </>
    )

  if (running.length > 1)
    return (
      <>
        <Spinner className="size-3.5" />
        {running.length} running
      </>
    )

  if (failed !== undefined)
    return (
      <span className="flex items-center gap-1.5 text-destructive">
        <TriangleAlert aria-hidden className="size-3.5" />
        {shortNames[failed.name]} failed
      </span>
    )

  if (props.jobs.some((job) => job.status.type === "waiting"))
    return (
      <>
        <Clock aria-hidden className="size-3.5" />
        Queued
      </>
    )

  return (
    <>
      <Sparkles aria-hidden className="size-3.5" />
      Agents
      {props.jobs.some((job) => job.saved?.outdatedHead != null) && (
        <span aria-hidden className="size-1.5 rounded-full bg-amber-500" />
      )}
    </>
  )
}

const describe = ({ status, saved, closed }: AgentJob) => {
  if (status.type === "running")
    return {
      state: (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Spinner className="size-3" />
          <Elapsed startedAt={status.startedAt} />
        </span>
      ),
      note: null,
    }

  if (status.type === "waiting")
    return {
      state: <span className="text-muted-foreground">Queued</span>,
      note: "Starts when another queued PR finishes.",
    }

  if (status.type === "failed")
    return { state: <span className="text-destructive">Failed</span>, note: status.message }

  if (saved?.outdatedHead != null)
    return {
      state: <span className={warningTone}>Outdated</span>,
      note: (
        <>
          Written for head <ShortSha sha={saved.outdatedHead} />
        </>
      ),
    }

  if (saved !== null)
    return { state: <span className="text-muted-foreground">{saved.summary}</span>, note: null }

  return { state: null, note: closed }
}

function IconButton(props: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <TooltipHint content={props.label}>
      <Button variant="ghost" size="icon-xs" aria-label={props.label} onClick={props.onClick}>
        {props.children}
      </Button>
    </TooltipHint>
  )
}

function JobRow(props: { job: AgentJob }) {
  const { job } = props
  const { start } = job
  const Icon = job.icon
  const { state, note } = describe(job)

  return (
    <li aria-label={job.name} className="rounded-md px-2 py-1.5">
      <div className="flex h-6 items-center gap-2 text-xs">
        <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{job.name}</span>
        {state}
        <span className="flex-1" />
        {job.saved !== null && (
          <Button variant="ghost" size="xs" onClick={job.read}>
            Read
          </Button>
        )}
        {busy(job) ? (
          <IconButton label="Cancel" onClick={job.cancel}>
            <Square aria-hidden className="size-3" />
          </IconButton>
        ) : (
          start !== null &&
          (job.saved === null && job.status.type !== "failed" ? (
            <Button variant="outline" size="xs" onClick={start.run}>
              {start.label}
            </Button>
          ) : (
            <IconButton label={start.label} onClick={start.run}>
              <RotateCw aria-hidden className="size-3" />
            </IconButton>
          ))
        )}
      </div>
      {note !== null && (
        <p
          className={cn(
            "pl-5.5 text-xs break-words",
            job.status.type === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {note}
        </p>
      )}
    </li>
  )
}

export function AgentWork(props: {
  tour: ReturnType<typeof useTour>
  reading: TourReading | null
  review: AgentReviewControls
  onReadTour: () => void
  onReadReview: () => void
}) {
  const jobs = [
    tourJob(props.tour, props.reading, props.onReadTour),
    reviewJob(props.review, props.onReadReview),
  ]

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label="Agent work"
            className="gap-1.5 font-normal text-muted-foreground tabular-nums aria-expanded:bg-muted aria-expanded:text-foreground"
          />
        }
      >
        <Summary jobs={jobs} />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-1">
        <ul aria-label="Agent work" className="flex flex-col">
          {jobs.map((job) => (
            <JobRow key={job.name} job={job} />
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

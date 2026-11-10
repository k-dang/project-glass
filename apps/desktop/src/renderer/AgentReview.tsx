import { cn } from "cn"
import { Clock, LoaderCircle, PanelRight, ScanSearch, TriangleAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Elapsed } from "./Elapsed"
import { ProblemAlert, withCode } from "./ProblemAlert"
import { warningTone } from "./PullRequestRow"
import { ShortSha } from "./shortSha"
import type { AgentReviewControls } from "./useAgentReview"

export const closedReason = (closedAs: "closed" | "merged") =>
  `Agent reviews are for open PRs, and this one is ${closedAs}.`

export function AgentReviewButton(props: { controls: AgentReviewControls; onRead: () => void }) {
  const { job, review, outdated, closedAs, start } = props.controls

  if (review !== null && !outdated)
    return (
      <Button variant="ghost" size="sm" onClick={props.onRead}>
        <PanelRight aria-hidden />
        Read Agent review
      </Button>
    )

  if (closedAs !== null)
    return (
      <Button
        variant="ghost"
        size="sm"
        disabled
        focusableWhenDisabled
        title={closedReason(closedAs)}
        className="cursor-default opacity-50 hover:bg-transparent dark:hover:bg-transparent"
      >
        <ScanSearch aria-hidden />
        Agent review
      </Button>
    )

  if (start === null) return null

  return (
    <Button
      variant="ghost"
      size="sm"
      title={
        job?.status === "reviewing"
          ? "Start the Agent review again"
          : "Ask an agent to review this Revision"
      }
      onClick={start}
    >
      <ScanSearch aria-hidden />
      Agent review
    </Button>
  )
}

function FailureLine(props: { detail: string; onRetry: (() => void) | null }) {
  return (
    <div
      role="alert"
      className="flex items-center gap-2 border-b px-6 py-1.5 text-sm text-destructive"
    >
      <TriangleAlert aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">Agent review failed.</span> {withCode(props.detail)}
      </span>
      {props.onRetry !== null && (
        <Button variant="outline" size="xs" onClick={props.onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export const failureOf = ({ job, commandProblem }: AgentReviewControls) => {
  if (job?.status === "failed") return job.reason.message

  return commandProblem === null ? null : `${commandProblem.title}. ${commandProblem.detail}`
}

export function ReviewingLine(props: {
  startedAt: number
  onCancel: () => void
  cancelSize: "xs" | "sm"
  className?: string
}) {
  return (
    <output
      aria-label="Agent review"
      className={cn("flex items-center gap-2 text-sm", props.className)}
    >
      <LoaderCircle
        aria-hidden
        className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <span className="font-medium">Agent reviewing…</span>
      <Elapsed startedAt={props.startedAt} />
      <span className="flex-1" />
      <Button variant="outline" size={props.cancelSize} onClick={props.onCancel}>
        Cancel
      </Button>
    </output>
  )
}

export function WaitingLine(props: {
  controls: AgentReviewControls
  size: "xs" | "sm"
  className?: string
}) {
  const { start, cancel } = props.controls

  return (
    <output
      aria-label="Agent review"
      className={cn("flex items-center gap-2 text-sm", props.className)}
    >
      <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">Agent review waiting…</span>
      <span className="text-muted-foreground">Starts when another queued review finishes.</span>
      <span className="flex-1" />
      {start !== null && (
        <Button variant="outline" size={props.size} onClick={start}>
          Review now
        </Button>
      )}
      <Button variant="outline" size={props.size} onClick={cancel}>
        Cancel
      </Button>
    </output>
  )
}

export function ReviewAgain(props: { controls: AgentReviewControls; size: "xs" | "sm" }) {
  const { start } = props.controls

  if (start === null) return null

  return (
    <Button variant="outline" size={props.size} onClick={start}>
      Review again
    </Button>
  )
}

export function AgentReviewBanner(props: { controls: AgentReviewControls; onRead: () => void }) {
  const { job, review, outdated, subscriptionProblem } = props.controls

  if (subscriptionProblem !== null)
    return (
      <div className="border-b px-6 py-3">
        <ProblemAlert
          problem={subscriptionProblem}
          action={{ label: "Reconnect", run: props.controls.reconnect }}
        />
      </div>
    )

  if (job?.status === "waiting")
    return <WaitingLine controls={props.controls} size="xs" className="border-b px-6 py-1.5" />

  if (job?.status === "reviewing")
    return (
      <ReviewingLine
        startedAt={job.startedAt}
        onCancel={props.controls.cancel}
        cancelSize="xs"
        className="border-b px-6 py-1.5"
      />
    )

  const failure = failureOf(props.controls)

  if (failure !== null) return <FailureLine detail={failure} onRetry={props.controls.start} />

  if (review === null || !outdated) return null

  return (
    <output
      aria-label="Agent review"
      className="flex items-center gap-2 border-b px-6 py-1.5 text-sm text-muted-foreground"
    >
      <TriangleAlert aria-hidden className={cn("size-4 shrink-0", warningTone)} />
      <span>
        Outdated: written for an older Revision (head <ShortSha sha={review.revision.head} />)
      </span>
      <span aria-hidden>·</span>
      <Button variant="link" size="xs" className="h-auto p-0 text-sm" onClick={props.onRead}>
        Read beside the diff
      </Button>
      <span className="flex-1" />
      <ReviewAgain controls={props.controls} size="xs" />
    </output>
  )
}

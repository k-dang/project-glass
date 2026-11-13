import { splitLead } from "@glass/contracts"
import { Clock, LoaderCircle, PanelLeft, ScanSearch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { Elapsed } from "./Elapsed"
import { HotspotSummary } from "./Hotspots"
import { OutdatedNote } from "./OutdatedNote"
import { ProblemAlert } from "./ProblemAlert"
import { rankHotspots } from "./rankedHotspots"
import type { AgentReviewControls } from "./useAgentReview"

export const closedReason = (closedAs: "closed" | "merged") =>
  `Agent reviews are for open PRs, and this one is ${closedAs}.`

export const failureOf = ({ job, commandProblem }: AgentReviewControls) => {
  if (job?.status === "failed") return job.reason.message

  return commandProblem === null ? null : `${commandProblem.title}. ${commandProblem.detail}`
}

function ReviewingLine(props: { startedAt: number; onCancel: () => void }) {
  return (
    <output aria-label="Agent review" className="flex items-center gap-2 text-sm">
      <LoaderCircle
        aria-hidden
        className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
      <span className="font-medium">Agent reviewing…</span>
      <Elapsed startedAt={props.startedAt} />
      <span className="flex-1" />
      <Button variant="outline" size="sm" onClick={props.onCancel}>
        Cancel
      </Button>
    </output>
  )
}

function WaitingLine(props: { controls: AgentReviewControls }) {
  const { start, cancel } = props.controls

  return (
    <output aria-label="Agent review" className="flex items-center gap-2 text-sm">
      <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="font-medium">Agent review waiting…</span>
      <span className="text-muted-foreground">Starts when another queued review finishes.</span>
      <span className="flex-1" />
      {start !== null && (
        <Button variant="outline" size="sm" onClick={start}>
          Review now
        </Button>
      )}
      <Button variant="outline" size="sm" onClick={cancel}>
        Cancel
      </Button>
    </output>
  )
}

function ReviewAgain(props: { controls: AgentReviewControls }) {
  const { start } = props.controls

  if (start === null) return null

  return (
    <Button variant="outline" size="sm" onClick={start}>
      Review again
    </Button>
  )
}

export function AgentReviewCard(props: {
  controls: AgentReviewControls
  onRead: () => void
  onReadHotspot: (rank: number) => void
}) {
  const { controls, onRead } = props
  const { review } = controls

  return (
    <Card render={<section />} aria-label="Agent review">
      <CardHeader>
        <CardTitle
          render={
            <h2>
              <ScanSearch aria-hidden className="size-4 text-muted-foreground" />
              Agent review
              <Badge variant="outline" className="font-normal text-muted-foreground">
                Only visible to you
              </Badge>
            </h2>
          }
          className="flex items-center gap-2 text-sm"
        />
      </CardHeader>
      <CardContent className="space-y-4">
        <AgentReviewStatus controls={controls} />
        {review !== null && (
          <>
            <AgentReviewMarkdown markdown={splitLead(review.markdown).lead} />
            <HotspotSummary
              hotspots={rankHotspots(review.hotspots)}
              onSelect={props.onReadHotspot}
            />
          </>
        )}
      </CardContent>
      {review !== null && (
        <CardFooter>
          <Button size="sm" onClick={onRead}>
            <PanelLeft aria-hidden />
            Read beside the diff
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}

function AgentReviewStatus(props: { controls: AgentReviewControls }) {
  const { controls } = props
  const { job, review, outdated, closedAs, start, subscriptionProblem } = controls

  if (subscriptionProblem !== null)
    return (
      <ProblemAlert
        problem={subscriptionProblem}
        action={{ label: "Reconnect", run: controls.reconnect }}
      />
    )

  if (job?.status === "waiting") return <WaitingLine controls={controls} />

  const reviewing = job?.status === "reviewing" ? job : null
  const failure = failureOf(controls)
  const outdatedReview = outdated ? review : null

  const outdatedNote = outdatedReview !== null && (
    <OutdatedNote
      revision={outdatedReview.revision}
      consequence="it may not match the code"
      action={reviewing === null && failure === null && <ReviewAgain controls={controls} />}
    />
  )

  if (reviewing !== null)
    return (
      <>
        <ReviewingLine startedAt={reviewing.startedAt} onCancel={controls.cancel} />
        {outdatedNote}
      </>
    )

  if (failure !== null)
    return (
      <>
        <ProblemAlert
          problem={{ title: "Agent review failed", detail: failure }}
          action={start === null ? undefined : { label: "Retry", run: start }}
        />
        {outdatedNote}
      </>
    )

  if (outdatedReview !== null) return outdatedNote

  if (review !== null) return null

  if (closedAs !== null)
    return <p className="text-sm text-muted-foreground">{closedReason(closedAs)}</p>

  if (start === null) return null

  return (
    <Item variant="outline" size="sm">
      <ItemContent className="basis-64">
        <ItemDescription className="line-clamp-none">
          An agent reads this Revision's code and points out what could go wrong. Nothing is posted
          to GitHub.
        </ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button size="sm" onClick={start}>
          <ScanSearch aria-hidden />
          Start Agent review
        </Button>
      </ItemActions>
    </Item>
  )
}

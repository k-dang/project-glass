import type { AgentReview } from "@glass/contracts"
import { PanelLeft, ScanSearch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item"
import { failureOf, ReviewAgain, ReviewingLine } from "./AgentReview"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { OutdatedNote } from "./OutdatedNote"
import { ProblemAlert } from "./ProblemAlert"
import type { AgentReviewControls } from "./useAgentReview"

export function AgentReviewCard(props: { controls: AgentReviewControls; onRead: () => void }) {
  const { controls, onRead } = props
  const { job, review, start, subscriptionProblem } = controls
  const idle = job === null || job.status === "idle"

  if (review === null && start === null && idle && subscriptionProblem === null) return null

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
        {review !== null && <AgentReviewLead review={review} onRead={onRead} />}
      </CardContent>
    </Card>
  )
}

function AgentReviewStatus(props: { controls: AgentReviewControls }) {
  const { controls } = props
  const { job, review, outdated, start, subscriptionProblem } = controls

  if (subscriptionProblem !== null)
    return (
      <ProblemAlert
        problem={subscriptionProblem}
        action={{ label: "Reconnect", run: controls.reconnect }}
      />
    )

  const reviewing = job?.status === "reviewing" ? job : null
  const failure = failureOf(controls)
  const outdatedReview = outdated ? review : null

  const outdatedNote = outdatedReview !== null && (
    <OutdatedNote
      revision={outdatedReview.revision}
      consequence="it may not match the code"
      action={
        reviewing === null && failure === null && <ReviewAgain controls={controls} size="sm" />
      }
    />
  )

  if (reviewing !== null)
    return (
      <>
        <ReviewingLine startedAt={reviewing.startedAt} onCancel={controls.cancel} cancelSize="sm" />
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

  if (review !== null || start === null) return null

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

/** The review's opening paragraph: the bold main risk and the sentences summing up the PR. */
const leadOf = (markdown: string) => markdown.split(/\n\s*\n/, 1)[0] ?? ""

function AgentReviewLead(props: { review: AgentReview; onRead: () => void }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
      <AgentReviewMarkdown
        markdown={leadOf(props.review.markdown)}
        className="min-w-0 flex-1 basis-64"
      />
      <Button size="sm" variant="outline" onClick={props.onRead}>
        <PanelLeft aria-hidden />
        Read beside the diff
      </Button>
    </div>
  )
}

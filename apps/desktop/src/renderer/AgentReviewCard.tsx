import { PanelLeft, ScanSearch } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemActions, ItemContent, ItemDescription } from "@/components/ui/item"
import { closedReason, failureOf, ReviewAgain, ReviewingLine, WaitingLine } from "./AgentReview"
import { AgentReviewMarkdown } from "./AgentReviewPanel"
import { OutdatedNote } from "./OutdatedNote"
import { ProblemAlert } from "./ProblemAlert"
import type { AgentReviewControls } from "./useAgentReview"

export function AgentReviewCard(props: { controls: AgentReviewControls; onRead: () => void }) {
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
        {review !== null && <AgentReviewMarkdown markdown={leadOf(review.markdown)} />}
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

  if (job?.status === "waiting") return <WaitingLine controls={controls} size="sm" />

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

const leadOf = (markdown: string) => markdown.split(/\n\s*\n/, 1)[0] ?? ""

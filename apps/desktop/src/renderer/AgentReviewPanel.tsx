import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import {
  emptyTranscript,
  nothingUnsent,
  type SentMessage,
  type SuggestedDraft,
  acceptedSuggestedDraftOf,
  type ToolCallPart,
} from "@glass/contracts"
import { cn } from "cn"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Check, LoaderCircle, Pencil } from "lucide-react"
import { type ReactNode, useCallback, useState } from "react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent } from "@/components/ui/marker"
import { Textarea } from "@/components/ui/textarea"
import { transcriptAtom } from "./agentsArea"
import { AgentComposer, ToolCallView, Transcript, UserMessage } from "./AgentView"
import type { ShowNote } from "./changesView"
import { LineLocation, pathLineName } from "./Discussions"
import { Elapsed } from "./Elapsed"
import { MessageBox } from "./MessageBox"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"
import type { AgentReviewControls } from "./useAgentReview"
import { type DraftStore, useDraftsLocked, useLineDraftPlaces } from "./useDrafts"

export function AgentReviewMarkdown(props: { markdown: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "text-sm leading-relaxed break-words [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
        // Long inline code such as paths wraps often here, so its chip is slim and wraps cleanly.
        "[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0 [&_:not(pre)>code]:text-[0.8125rem] [&_:not(pre)>code]:[box-decoration-break:clone]",
        props.className,
      )}
    >
      {props.markdown}
    </Streamdown>
  )
}

const fileName = (path: string) => path.split("/").at(-1) ?? path

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

/** A Draft the agent proposed: the user reads it, edits it if they like, then adds it to their pending Review. */
function SuggestedDraftCard(props: {
  draft: SuggestedDraft
  drafts: DraftStore
  addable: boolean
  show: ShowNote
}) {
  const { draft } = props
  const [body, setBody] = useState(draft.body)
  const [editing, setEditing] = useState(false)
  const locked = useDraftsLocked(props.drafts)

  const onLine = useLineDraftPlaces(props.drafts).some(
    (place) => place.path === draft.path && place.side === draft.side && place.line === draft.line,
  )

  const name = pathLineName(draft.path, draft.side, draft.line)

  return (
    <section
      aria-label={`Suggested draft on ${name}`}
      className={cn(
        "flex flex-col rounded-lg border transition-[background-color] duration-200 ease-(--ease-out)",
        onLine ? "border-dashed" : "bg-muted/30",
      )}
    >
      <header className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <button
          type="button"
          title={draft.path}
          className="flex min-w-0 items-center gap-1.5 text-left hover:text-foreground"
          onClick={() => props.show.line(draft.path, draft.side, draft.line)}
        >
          <span className="truncate font-medium">{fileName(draft.path)}</span>
          <LineLocation side={draft.side} line={draft.line} />
        </button>
        <span className="ml-auto shrink-0">Suggested Draft</span>
      </header>
      {editing && props.addable && !onLine ? (
        <div className="px-3 pt-2">
          <Textarea
            ref={focusOnMount}
            aria-label={`Suggested draft on ${name}`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-12 resize-none bg-background text-sm"
          />
        </div>
      ) : (
        <AgentReviewMarkdown
          markdown={body}
          className={cn("px-3 pt-1", onLine && "text-muted-foreground")}
        />
      )}
      {onLine ? (
        <p className="m-0 flex items-center justify-end gap-1.5 px-3 py-2 text-xs text-muted-foreground enter-motion">
          <Check aria-hidden className="size-3.5 shrink-0 text-added" />
          You have a Draft on this line.
        </p>
      ) : (
        props.addable && (
          <footer className="flex justify-end gap-1 p-2">
            {!editing && (
              <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
                <Pencil />
                Edit
              </Button>
            )}
            <Button
              size="xs"
              variant="secondary"
              disabled={locked || body.trim() === ""}
              onClick={() => props.drafts.add(draft.path, draft.side, draft.line, body.trim())}
            >
              Add Draft
            </Button>
          </footer>
        )
      )}
    </section>
  )
}

function FollowUpsMarker() {
  return (
    <Marker variant="separator" aria-hidden className="my-6 text-xs">
      <MarkerContent>Follow-ups</MarkerContent>
    </Marker>
  )
}

function FirstFollowUp(props: { controls: AgentReviewControls }) {
  const { job } = props.controls

  if (job?.status !== "starting-agent" && job?.status !== "agent-start-failed") return null

  return (
    <>
      <FollowUpsMarker />
      <div className="flex flex-col gap-3 enter-motion">
        <UserMessage message={job.message} images={[]} />
        {job.status === "starting-agent" ? (
          <output className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle
              aria-hidden
              className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
            />
            <span className="flex-1">Copying the PR's code for the agent…</span>
            <Elapsed startedAt={job.startedAt} />
          </output>
        ) : (
          <ProblemAlert
            problem={{ title: "Follow-up failed", detail: job.reason.message }}
            action={
              props.controls.followUpPending
                ? undefined
                : { label: "Retry", run: () => props.controls.followUp(job.message) }
            }
          />
        )}
      </div>
    </>
  )
}

function FirstFollowUpComposer(props: { controls: AgentReviewControls; reviewing: boolean }) {
  const [composed, setComposed] = useState<SentMessage>(nothingUnsent)
  const { job } = props.controls

  return (
    <MessageBox
      composed={composed}
      setComposed={setComposed}
      label="Follow up"
      placeholder="Ask about the review, or have it draft comments"
      textOnly
      holdUntilAccepted
      blocked={
        props.controls.followUpPending || props.reviewing || job?.status === "starting-agent"
      }
      problem={props.controls.followUpProblem}
      send={({ message }) => props.controls.followUp(message)}
      steer={null}
      recall={null}
      onStop={job?.status === "starting-agent" ? props.controls.cancel : null}
    />
  )
}

function OutdatedNote() {
  return (
    <p className="m-0 shrink-0 border-t px-5 py-3 text-sm text-muted-foreground">
      Written for an older Revision. Review again to follow up.
    </p>
  )
}

function ReviewAgent(props: {
  agentId: string
  lead: ReactNode
  outdated: boolean
  drafts: DraftStore
  show: ShowNote
}) {
  const { agentId, drafts, show, outdated } = props
  const transcript = useAtomValue(transcriptAtom(agentId))
  const reconnect = useAtomRefresh(transcriptAtom(agentId))

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const suggestedDraftView = useCallback(
    (call: typeof ToolCallPart.Type) => {
      const draft = acceptedSuggestedDraftOf(call)

      return draft === null ? null : (
        <SuggestedDraftCard draft={draft} drafts={drafts} addable={!outdated} show={show} />
      )
    },
    [drafts, outdated, show],
  )

  return (
    <ToolCallView value={suggestedDraftView}>
      {AsyncResult.isFailure(transcript) && !transcript.waiting && (
        <div className="px-5 pt-4">
          <ProblemAlert
            problem={streamProblem(transcript.cause)}
            action={{ label: "Reconnect", run: reconnect }}
          />
        </div>
      )}
      <Transcript
        agentId={agentId}
        turns={turns}
        status={status}
        lead={
          <>
            {props.lead}
            <FollowUpsMarker />
          </>
        }
      />
      {outdated ? (
        <OutdatedNote />
      ) : (
        <AgentComposer
          agentId={agentId}
          turns={turns}
          queued={queued}
          label="Follow up"
          idlePlaceholder="Ask about the review, or have it draft comments"
          textOnly
        />
      )}
    </ToolCallView>
  )
}

export function AgentReviewPanel(props: {
  controls: AgentReviewControls
  drafts: DraftStore
  show: ShowNote
}) {
  const { review, job, outdated } = props.controls

  if (review === null) return null

  const markdown = <AgentReviewMarkdown markdown={review.markdown} />

  if (review.agentId !== null)
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ReviewAgent
          key={review.agentId}
          agentId={review.agentId}
          lead={markdown}
          outdated={outdated}
          drafts={props.drafts}
          show={props.show}
        />
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <section aria-label="Agent review" className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8">
        {markdown}
        <FirstFollowUp controls={props.controls} />
      </section>
      <div
        aria-hidden
        className="pointer-events-none relative -mt-8 h-8 shrink-0 bg-linear-to-t from-background to-transparent"
      />
      {outdated ? (
        <OutdatedNote />
      ) : (
        <FirstFollowUpComposer controls={props.controls} reviewing={job?.status === "reviewing"} />
      )}
    </div>
  )
}

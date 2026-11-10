import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
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
import { AsyncResult, Atom } from "effect/reactivity"
import { Check, LoaderCircle, Pencil, X } from "lucide-react"
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent } from "@/components/ui/marker"
import { Textarea } from "@/components/ui/textarea"
import { agentConversation, ConversationContext } from "./conversation"
import { AgentComposer, ToolCallView, Transcript, UserMessage } from "./AgentView"
import type { ShowNote } from "./changesView"
import { LineLocation, pathLineName } from "./Discussions"
import { Elapsed } from "./Elapsed"
import { type ComposerSuggestion, MessageBox } from "./MessageBox"
import { ProblemAlert } from "./ProblemAlert"
import { fileName } from "./fileName"
import { streamProblem } from "./problems"
import type { AgentReviewControls } from "./useAgentReview"
import { type DraftStore, useDraftsLocked, useLineDraftPlaces } from "./useDrafts"

export function AgentReviewMarkdown(props: { markdown: string; className?: string }) {
  return (
    <Streamdown
      className={cn(
        "text-sm leading-relaxed break-words [&_h2]:mt-5 [&_h2]:mb-1 [&_h2]:text-sm [&_h2]:font-semibold",
        "[&_:not(pre)>code]:px-1 [&_:not(pre)>code]:py-0 [&_:not(pre)>code]:text-[0.8125rem] [&_:not(pre)>code]:[box-decoration-break:clone]",
        props.className,
      )}
    >
      {props.markdown}
    </Streamdown>
  )
}

const followUpSuggestions: ReadonlyArray<ComposerSuggestion> = [
  {
    label: "Draft PR comments",
    prompt:
      "Draft PR comments without using jargon and speak coherently. State it more simply and concisely, like one human talking to another.",
  },
]

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

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
      suggestions={followUpSuggestions}
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
  const conversation = useMemo(() => agentConversation(agentId), [agentId])
  const transcript = useAtomValue(conversation.transcript)
  const reconnect = useAtomRefresh(conversation.transcript)

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
    <ConversationContext value={conversation}>
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
            turns={turns}
            queued={queued}
            label="Follow up"
            idlePlaceholder="Ask about the review, or have it draft comments"
            textOnly
            suggestions={followUpSuggestions}
          />
        )}
      </ToolCallView>
    </ConversationContext>
  )
}

export function AgentReviewPanel(props: {
  review: NonNullable<AgentReviewControls["review"]>
  controls: AgentReviewControls
  drafts: DraftStore
  show: ShowNote
}) {
  const { review } = props
  const { job, outdated } = props.controls
  const markdown = <AgentReviewMarkdown markdown={review.markdown} />

  if (review.agentId !== null)
    return (
      <ReviewAgent
        key={review.agentId}
        agentId={review.agentId}
        lead={markdown}
        outdated={outdated}
        drafts={props.drafts}
        show={props.show}
      />
    )

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-8">
        {markdown}
        <FirstFollowUp controls={props.controls} />
      </div>
      <div
        aria-hidden
        className="pointer-events-none relative -mt-8 h-8 shrink-0 bg-linear-to-t from-background to-transparent"
      />
      {outdated ? (
        <OutdatedNote />
      ) : (
        <FirstFollowUpComposer controls={props.controls} reviewing={job?.status === "reviewing"} />
      )}
    </>
  )
}

const minWidth = 320

const widthStep = 32

/** The width the user last dragged the Agent review panel to, kept across PR workspaces. */
const panelWidthAtom = Atom.make(480).pipe(Atom.keepAlive)

const maxWidth = () => Math.max(minWidth, Math.round(window.innerWidth * 0.6))

const clampWidth = (width: number) => Math.min(maxWidth(), Math.max(minWidth, width))

function ResizeHandle(props: { width: number; onResize: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { x: event.clientX, width: props.width }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return

    props.onResize(drag.current.width + drag.current.x - event.clientX)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: widthStep, ArrowRight: -widthStep }[event.key]

    if (step === undefined) return

    event.preventDefault()
    props.onResize(props.width + step)
  }

  return (
    <div
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- A focusable separator is the ARIA window splitter, which `hr` can't be.
      role="separator"
      aria-label="Resize the Agent review"
      aria-orientation="vertical"
      aria-valuenow={props.width}
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth()}
      tabIndex={0}
      className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 hover:after:bg-ring focus-visible:after:bg-ring"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onKeyDown={onKeyDown}
    />
  )
}

/**
 * The Agent review beside the diff, on its right, at a width the user can drag. Its content comes
 * in as `children`, so a drag re-renders only the frame, not the transcript and composer.
 */
export function AgentReviewSidePanel(props: { onClose: () => void; children: ReactNode }) {
  const [stored, setWidth] = useAtom(panelWidthAtom)
  const width = clampWidth(stored)

  return (
    <aside
      aria-label="Agent review"
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l bg-background"
    >
      <ResizeHandle width={width} onResize={(next) => setWidth(clampWidth(next))} />
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-5">
        <h2 className="flex-1 truncate font-medium">Agent review</h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close the Agent review"
          onClick={props.onClose}
        >
          <X aria-hidden />
        </Button>
      </header>
      {props.children}
    </aside>
  )
}

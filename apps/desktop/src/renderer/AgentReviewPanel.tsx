import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  type AgentReview,
  emptyTranscript,
  type SuggestedDraft,
  splitLead,
  acceptedSuggestedDraftOf,
  type ToolCallPart,
} from "@glass/contracts"
import { cn } from "cn"
import { Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Check, Pencil } from "lucide-react"
import { type ReactNode, useCallback, useMemo, useState } from "react"
import { Streamdown } from "streamdown"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent } from "@/components/ui/marker"
import { Textarea } from "@/components/ui/textarea"
import { threadAtoms, ThreadAtomsContext } from "./thread"
import { ThreadComposer } from "./ThreadView"
import { Transcript } from "./Transcript"
import { ToolCallView } from "./TurnParts"
import type { ShowNote } from "./changesView"
import { LineLocation, pathLineName } from "./ReviewThreads"
import { type HotspotLinks, HotspotPoints } from "./Hotspots"
import { rankHotspots } from "./rankedHotspots"
import type { ComposerSuggestion } from "./MessageBox"
import { ProblemAlert } from "./ProblemAlert"
import { SidePanel } from "./SidePanel"
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

function ReviewBody(props: { review: AgentReview; links: HotspotLinks; outdated: boolean }) {
  const { lead, rest } = splitLead(props.review.markdown)

  return (
    <>
      <AgentReviewMarkdown markdown={lead} />
      <HotspotPoints
        hotspots={rankHotspots(props.review.hotspots)}
        links={props.links}
        outdated={props.outdated}
      />
      {rest !== "" && <AgentReviewMarkdown markdown={rest} />}
    </>
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

function OutdatedNote() {
  return (
    <p className="m-0 shrink-0 border-t px-5 py-3 text-sm text-muted-foreground">
      Written for an older Revision. Review again to follow up.
    </p>
  )
}

function ReviewThread(props: {
  threadId: string
  lead: ReactNode
  outdated: boolean
  drafts: DraftStore
  show: ShowNote
}) {
  const { threadId, drafts, show, outdated } = props
  const atoms = useMemo(() => threadAtoms(threadId), [threadId])
  const transcript = useAtomValue(atoms.transcript)
  const reconnect = useAtomRefresh(atoms.transcript)

  const { turns, earlierTurns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const followUps = useMemo(
    () => turns.filter(({ context }) => !Predicate.isTagged(context, "AgentReview")),
    [turns],
  )

  const loadEarlier = useAtomSet(atoms.loadEarlier)

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
    <ThreadAtomsContext value={atoms}>
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
          turns={followUps}
          earlierTurns={earlierTurns}
          onShowEarlier={loadEarlier}
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
          <ThreadComposer
            turns={followUps}
            queued={queued}
            label="Follow up"
            idlePlaceholder="Ask about the review, or have it draft comments"
            textOnly
            suggestions={followUpSuggestions}
          />
        )}
      </ToolCallView>
    </ThreadAtomsContext>
  )
}

export function AgentReviewPanel(props: {
  review: NonNullable<AgentReviewControls["review"]>
  controls: AgentReviewControls
  drafts: DraftStore
  show: ShowNote
  hotspotLinks: HotspotLinks
}) {
  const { review } = props
  const { outdated } = props.controls
  const markdown = <ReviewBody review={review} links={props.hotspotLinks} outdated={outdated} />

  return (
    <ReviewThread
      key={review.threadId}
      threadId={review.threadId}
      lead={markdown}
      outdated={outdated}
      drafts={props.drafts}
      show={props.show}
    />
  )
}

const panelWidthAtom = Atom.make(480).pipe(Atom.keepAlive)

export function AgentReviewSidePanel(props: { onClose: () => void; children: ReactNode }) {
  return (
    <SidePanel
      name="Agent review"
      heading="Agent review"
      width={panelWidthAtom}
      onClose={props.onClose}
    >
      {props.children}
    </SidePanel>
  )
}

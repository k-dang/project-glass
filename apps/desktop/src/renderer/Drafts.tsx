import { LoaderCircle, PenLine, RotateCw, Sparkles, Trash2 } from "lucide-react"
import { Match, Predicate } from "effect"
import { type ReactNode, useCallback, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import {
  DiffHunk,
  LineLocation,
  lineName,
  originalLineName,
  PublishedDraftThread,
} from "./Discussions"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ProblemAlert } from "./ProblemAlert"
import { problemText } from "./problems"
import { optionLabel, shortcutLabel } from "./shortcutLabel"
import {
  type DraftStore,
  type DraftView,
  type Feedback,
  type Submission,
  useDraft,
  useDraftCount,
  useDraftsLocked,
  useDraftViews,
  useSubmission,
} from "./useDrafts"
import type { ShowNote } from "./changesView"

const feedbackLabel = Match.type<NonNullable<Feedback>>().pipe(
  Match.discriminatorsExhaustive("type")({
    draft: () => "Saved privately",
    unsaved: () => "Not saved",
    sending: ({ action }) => (action === "delete" ? "Deleting…" : "Saving…"),
    failed: ({ action }) => (action === "delete" ? "Couldn't delete" : "Couldn't save"),
  }),
)

export const feedbackText = (feedback: Feedback) =>
  feedback === null ? null : feedbackLabel(feedback)

export const showDraft = (show: ShowNote, { path, place }: DraftView) =>
  Predicate.isTagged(place, "LinePlace") ? show.line(path, place.side, place.line) : show.file(path)

function DraftFeedback(props: { draft: DraftView; locked: boolean; onRetry: () => void }) {
  const { feedback } = props.draft

  if (feedback === null) return null

  if (feedback.type !== "failed") {
    return (
      <span className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {feedback.type === "sending" && (
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        )}
        {feedbackText(feedback)}
      </span>
    )
  }

  return (
    <span className="flex shrink-0 items-center gap-2">
      <span className="text-destructive">{feedbackText(feedback)}</span>
      <Button
        variant="outline"
        size="xs"
        disabled={props.locked}
        onClick={props.onRetry}
        aria-label={`Retry Draft on ${draftName(props.draft)}`}
      >
        <RotateCw data-icon="inline-start" aria-hidden />
        Retry
      </Button>
    </span>
  )
}

const placeName = ({ place }: DraftView) =>
  Predicate.isTagged(place, "LinePlace")
    ? lineName(place.side, place.line)
    : originalLineName(place.originalLine)

const draftName = (draft: DraftView) => `${draft.path} ${placeName(draft)}`

export function DraftLocation(props: { draft: DraftView }) {
  const { place } = props.draft

  if (Predicate.isTagged(place, "LinePlace"))
    return <LineLocation side={place.side} line={place.line} />

  return <span>{placeName(props.draft)}</span>
}

export const draftBody = (body: string) =>
  body.trim() === "" ? <em className="text-muted-foreground">Empty</em> : body

function DraftCard(props: {
  draft: DraftView
  store: DraftStore
  location: ReactNode
  aside?: ReactNode
  children: ReactNode
}) {
  const { draft, store } = props
  const { feedback } = draft
  const locked = useDraftsLocked(store)

  return (
    <section className="overflow-hidden rounded-lg border border-dashed border-modified/70 bg-modified/5 font-sans">
      <header className="flex items-center gap-2 border-b border-dashed border-modified/40 px-3 py-2 text-sm">
        <PenLine className="size-4 shrink-0 text-modified" aria-hidden />
        <span className="min-w-0 flex-1 truncate">Draft on {props.location}</span>
        {props.aside}
        <DraftFeedback draft={draft} locked={locked} onRetry={() => store.save(draft.key)} />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Delete Draft on ${draftName(draft)}`}
          title="Delete Draft"
          disabled={locked || (feedback?.type === "sending" && feedback.action === "delete")}
          onClick={() => store.remove(draft.key)}
        >
          <Trash2 aria-hidden />
        </Button>
      </header>
      {props.children}
      {feedback?.type === "failed" && (
        <p className="border-t border-dashed border-modified/40 px-3 py-2 text-sm text-destructive">
          {problemText(feedback.problem)}
        </p>
      )}
    </section>
  )
}

function DraftActions(props: {
  draft: DraftView
  disabled: boolean
  canComment: boolean
  canAsk: boolean
  submission: Submission
  onSave: () => void
  onComment: () => void
  onReload: () => void
  onAsk: () => void
}) {
  const { draft, disabled, canComment, canAsk, submission } = props
  const failure = submission.type === "failed" ? submission.problem : null
  const awaitingReload = failure?.fixedByReload === true
  const unsaved = draft.feedback?.type === "unsaved"

  if (!unsaved && !canComment && !canAsk) return null

  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <div className="flex items-center justify-end gap-3 text-sm text-muted-foreground">
        {canAsk && (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={props.onAsk}
            aria-label={`Ask the agent about ${draftName(draft)}`}
            title="Ask the agent instead. Only you see the answer; nothing goes to GitHub."
            className="mr-auto text-primary"
          >
            <Sparkles data-icon="inline-start" aria-hidden />
            Ask the agent
            <Kbd>{shortcutLabel("↵")}</Kbd>
          </Button>
        )}
        {unsaved && (
          <span>
            <Kbd>↵</Kbd> saves it for your Review
          </span>
        )}
        {canComment && (
          <span>
            <Kbd>⇧↵</Kbd> comments now
          </span>
        )}
        <span>
          <Kbd>{optionLabel("↵")}</Kbd> adds a line
        </span>
        {unsaved && (
          <Button
            size="sm"
            variant="outline"
            disabled={disabled}
            onClick={props.onSave}
            aria-label={`Save Draft on ${draftName(draft)}`}
          >
            Save Draft
          </Button>
        )}
        {canComment && (
          <Button
            disabled={disabled || awaitingReload}
            onClick={props.onComment}
            aria-label={`Comment with Draft on ${draftName(draft)}`}
          >
            {submission.type === "sending" && (
              <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
            )}
            Comment
          </Button>
        )}
      </div>
      {canComment && failure !== null && (
        <ProblemAlert
          problem={failure}
          action={awaitingReload ? { label: "Reload", run: props.onReload } : undefined}
        />
      )}
    </div>
  )
}

export function LineDraft(props: {
  store: DraftStore
  draftKey: string
  onReload: () => void
  onAsk: () => void
}) {
  const { store, draftKey } = props
  const draft = useDraft(store, draftKey)
  const draftCount = useDraftCount(store)
  const locked = useDraftsLocked(store)
  const submission = useSubmission(store)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const focusStarted = useCallback(
    (element: HTMLTextAreaElement | null) => {
      if (element !== null && store.takeStarted(draftKey)) element.focus()
    },
    [store, draftKey],
  )

  if (draft === undefined) return null

  if (draft.published) {
    return (
      <PublishedDraftThread
        location={<DraftLocation draft={draft} />}
        viewer={store.workspace.viewer}
        body={draft.body}
      />
    )
  }

  const readOnly = draft.deleting || locked
  const empty = draft.body.trim() === ""
  const canComment = draftCount === 1 && !empty
  const canAsk = draft.local && !empty

  const comment = async () => {
    if ((await store.submit("comment", "")).type === "submitted") props.onReload()
  }

  return (
    <DraftCard draft={draft} store={props.store} location={<DraftLocation draft={draft} />}>
      <div className="p-3">
        <Textarea
          value={draft.body}
          onChange={(event) => props.store.edit(draft.key, event.target.value)}
          ref={focusStarted}
          readOnly={readOnly}
          onKeyDown={(event) => {
            // Enter and Escape can confirm or dismiss an input method's candidates.
            if (event.nativeEvent.isComposing || readOnly) return

            if (event.key === "Enter") {
              event.preventDefault()

              if ((event.metaKey || event.ctrlKey) && canAsk) {
                props.onAsk()
              } else if (event.altKey) {
                const field = event.currentTarget
                field.setRangeText("\n", field.selectionStart, field.selectionEnd, "end")
                props.store.edit(draft.key, field.value)
              } else if (!event.shiftKey) {
                props.store.save(draft.key)
              } else if (canComment) {
                void comment()
              }
            }

            if (event.key === "Escape") {
              event.preventDefault()
              event.stopPropagation()

              if (empty) {
                props.store.remove(draft.key)
              } else {
                setConfirmDelete(true)
              }
            }
          }}
          placeholder={
            draft.local
              ? `Leave a comment, or ask the agent with ${shortcutLabel("↵")}.`
              : "Leave a comment. Only you can see it until you submit a Review."
          }
          aria-label={`Draft on ${draftName(draft)}`}
          className="bg-background"
        />
      </div>
      <DraftActions
        draft={draft}
        disabled={readOnly}
        canComment={canComment}
        canAsk={canAsk}
        submission={submission}
        onSave={() => store.save(draft.key)}
        onComment={comment}
        onReload={props.onReload}
        onAsk={props.onAsk}
      />
      <ConfirmationDialog
        open={confirmDelete}
        title="Delete this Draft?"
        description={`Your Draft on ${draftName(draft)} will be deleted.`}
        confirmLabel="Delete Draft"
        onConfirm={() => {
          setConfirmDelete(false)
          store.remove(draft.key)
        }}
        onCancel={() => setConfirmDelete(false)}
      />
    </DraftCard>
  )
}

function ListedDraft(props: {
  draft: DraftView
  store: DraftStore
  onShow: (draft: DraftView) => void
}) {
  const { draft } = props
  const { place } = draft

  return (
    <DraftCard
      draft={draft}
      store={props.store}
      location={
        <>
          <Button
            type="button"
            variant="link"
            onClick={() => props.onShow(draft)}
            className="h-auto p-0 font-mono font-normal text-inherit"
            title={`Show ${draft.path} in Changes`}
          >
            {draft.path}
          </Button>{" "}
          <DraftLocation draft={draft} />
        </>
      }
      aside={Predicate.isTagged(place, "FlaggedPlace") && <Badge variant="outline">Flagged</Badge>}
    >
      {Predicate.isTagged(place, "FlaggedPlace") && place.diffHunk !== "" && (
        <DiffHunk hunk={place.diffHunk} />
      )}
      <p className="px-4 py-3 text-sm whitespace-pre-wrap">{draftBody(draft.body)}</p>
    </DraftCard>
  )
}

export function DraftList(props: { store: DraftStore; onShow: (draft: DraftView) => void }) {
  const drafts = useDraftViews(props.store)

  if (drafts.length === 0) return null

  const onLines = drafts.filter((draft) => Predicate.isTagged(draft.place, "LinePlace"))
  const flagged = drafts.filter((draft) => Predicate.isTagged(draft.place, "FlaggedPlace"))

  const list = (listed: ReadonlyArray<DraftView>) => (
    <ul className="flex flex-col gap-3">
      {listed.map((draft) => (
        <li key={draft.key}>
          <ListedDraft draft={draft} store={props.store} onShow={props.onShow} />
        </li>
      ))}
    </ul>
  )

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Your Drafts · {drafts.length}</h2>
      <p className="text-sm text-muted-foreground">
        Saved to your pending review on GitHub, where only you can see them until you submit a
        Review.
      </p>
      {onLines.length > 0 && list(onLines)}
      {flagged.length > 0 && (
        <>
          <h3 className="mt-2 text-sm font-semibold">Flagged drafts · {flagged.length}</h3>
          <p className="text-sm text-muted-foreground">
            They can't sit in this Revision's diff: GitHub reports their lines changed since they
            were written, or they're on a whole file or a file whose diff isn't shown. Glass never
            moves them: kept, each publishes where it was written. To comment elsewhere, delete one
            and write a new one.
          </p>
          {list(flagged)}
        </>
      )}
    </section>
  )
}

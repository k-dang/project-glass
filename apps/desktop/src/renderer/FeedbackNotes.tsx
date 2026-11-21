import { type FeedbackNote, LineNote, PageNote, type PagePart } from "@glass/contracts"
import { cn } from "cn"
import { Match } from "effect"
import { History, MessageSquarePlus, PenLine, Trash2, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { isOlder, rangeLabel } from "./feedbackLines"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import type { Problem } from "./problems"
import { shortcutLabel } from "./shortcutLabel"
import { submitOnShortcut } from "./submitShortcut"

function OlderVersion() {
  return (
    <Badge variant="outline" className="gap-1 text-muted-foreground">
      <History aria-hidden />
      Older version
    </Badge>
  )
}

function Snippet(props: { code: string }) {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs leading-5">
      {props.code}
    </pre>
  )
}

interface NoteView {
  readonly place: string
  readonly location: string
  readonly about: "code" | "page"
  readonly code: string | null
  readonly quote: string | null
}

const quoted = (text: string) => `“${text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text}”`

export const pagePartLabel = (part: PagePart) =>
  Match.valueTags(part, {
    PageText: ({ excerpt }) => quoted(excerpt),
    PageElement: ({ label }) => label,
  })

const viewOf = (note: FeedbackNote): NoteView =>
  Match.valueTags(note, {
    LineNote: ({ path, side, start, end, code }): NoteView => {
      const place = rangeLabel(side, start, end)

      return { place, location: `${path} ${place}`, about: "code", code, quote: null }
    },
    PageNote: ({ path, part }): NoteView => {
      const place = pagePartLabel(part)

      return {
        place,
        location: `${path} · ${place}`,
        about: "page",
        code: null,
        quote: part.excerpt,
      }
    },
  })

export function FeedbackNoteCard(props: {
  note: FeedbackNote
  olderCode: string | null
  location: string
  onShow: (() => void) | null
  onEdit: (() => void) | null
  onRemove: () => Promise<Problem | null>
}) {
  const { note, olderCode } = props
  const [removing, setRemoving] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  const remove = async () => {
    setRemoving(true)
    const failed = await props.onRemove()
    setProblem(failed)

    if (failed !== null) setRemoving(false)
  }

  return (
    <article
      aria-label={`Feedback on ${viewOf(note).location}`}
      className="flex flex-col gap-2 rounded-lg border bg-background p-3 font-sans text-sm"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {props.onShow === null ? (
          <span className="min-w-0 truncate">{props.location}</span>
        ) : (
          <button
            type="button"
            className="min-w-0 truncate hover:text-foreground hover:underline"
            onClick={props.onShow}
          >
            {props.location}
          </button>
        )}
        {olderCode !== null && <OlderVersion />}
      </div>
      {olderCode !== null && <Snippet code={olderCode} />}
      <p className="whitespace-pre-wrap wrap-anywhere">{note.text}</p>
      {problem !== null && (
        <ProblemAlert problem={problem} action={{ label: "Retry", run: () => void remove() }} />
      )}
      <div className="flex gap-1">
        <Button
          variant="ghost"
          size="xs"
          onClick={props.onEdit ?? undefined}
          disabled={removing || props.onEdit === null}
        >
          <PenLine data-icon="inline-start" aria-hidden />
          Edit
        </Button>
        <Button variant="ghost" size="xs" onClick={() => void remove()} disabled={removing}>
          <Trash2 data-icon="inline-start" aria-hidden />
          Remove
        </Button>
      </div>
    </article>
  )
}

export const withText = (note: FeedbackNote, text: string) =>
  Match.valueTags(note, {
    // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into LineNote.
    LineNote: (line) => new LineNote({ ...line, text }),
    // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into PageNote.
    PageNote: (page) => new PageNote({ ...page, text }),
  })

export interface StagedEdit {
  readonly id: string
  readonly draft: string
}

export function StagedFeedback(props: {
  notes: ReadonlyArray<FeedbackNote>
  editing: StagedEdit | null
  onEditingChange: (editing: StagedEdit | null) => void
  onSave: (note: FeedbackNote) => Promise<Problem | null>
  onRemove: (noteId: string) => Promise<Problem | null>
}) {
  const { editing, onEditingChange: setEditing } = props

  return (
    <section
      aria-label="Feedback attached to this message"
      className="flex max-h-72 flex-col gap-2 overflow-y-auto py-1 text-left"
    >
      <p className="text-xs text-muted-foreground">
        {plural(props.notes.length, "Feedback note")} attached to this message
      </p>
      <ul className="flex flex-col gap-2">
        {props.notes.map((note) => (
          <li key={note.id}>
            {editing?.id === note.id ? (
              <FeedbackEditor
                place={viewOf(note).place}
                about={viewOf(note).about}
                olderCode={null}
                saved
                draft={editing.draft}
                onDraftChange={(draft) => setEditing({ id: note.id, draft })}
                onSave={async (text) => {
                  const problem = await props.onSave(withText(note, text))

                  if (problem === null) setEditing(null)

                  return problem
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <FeedbackNoteCard
                note={note}
                olderCode={null}
                location={viewOf(note).location}
                onShow={null}
                onEdit={
                  editing === null ? () => setEditing({ id: note.id, draft: note.text }) : null
                }
                onRemove={() => props.onRemove(note.id)}
              />
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function SentFeedback(props: { feedback: ReadonlyArray<FeedbackNote>; className?: string }) {
  return (
    <details className={cn("rounded-lg border bg-background px-3 py-2 text-sm", props.className)}>
      <summary className="cursor-pointer text-xs text-muted-foreground">
        {plural(props.feedback.length, "Feedback note")}
      </summary>
      <ul className="flex flex-col gap-3 pt-2">
        {props.feedback.map((note) => (
          <SentNote key={note.id} note={note} />
        ))}
      </ul>
    </details>
  )
}

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

function SentNote(props: { note: FeedbackNote }) {
  const { location, code, quote } = viewOf(props.note)

  return (
    <li className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{location}</span>
      {code !== null && <Snippet code={code} />}
      {quote !== null && (
        <p className="line-clamp-3 border-l-2 pl-2 text-xs text-muted-foreground wrap-anywhere">
          {quote}
        </p>
      )}
      <p className="whitespace-pre-wrap wrap-anywhere">{props.note.text}</p>
    </li>
  )
}

export function FeedbackEditor(props: {
  place: string
  about: "code" | "page"
  olderCode: string | null
  saved: boolean
  draft: string
  onDraftChange: (draft: string) => void
  onSave: (text: string) => Promise<Problem | null>
  onCancel: () => void
}) {
  const { olderCode, saved, draft } = props
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const empty = draft.trim() === ""

  const save = async () => {
    if (empty || saving) return

    setSaving(true)
    const failed = await props.onSave(draft.trim())
    setSaving(false)
    setProblem(failed)
  }

  return (
    <form
      aria-label={saved ? "Edit Feedback note" : "Add Feedback note"}
      className="flex flex-col gap-2 rounded-lg border bg-background p-3 font-sans text-sm shadow-sm"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {saved ? "Edit feedback" : "Add feedback"}
        </span>
        <span className="min-w-0 truncate">{props.place}</span>
        {olderCode !== null && <OlderVersion />}
      </div>
      {olderCode !== null && <Snippet code={olderCode} />}
      <Textarea
        value={draft}
        ref={focusOnMount}
        aria-label={
          props.about === "code"
            ? "Feedback on selected code"
            : "Feedback on the selected part of the page"
        }
        placeholder="What should the agent change here?"
        className="bg-background"
        onChange={(event) => props.onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          submitOnShortcut(event)

          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            props.onCancel()
          }
        }}
      />
      {problem !== null && <ProblemAlert problem={problem} />}
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto flex items-center gap-1 text-xs text-muted-foreground">
          <Kbd>{shortcutLabel("↵")}</Kbd> to save
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={empty || saving}>
          {saved ? "Save changes" : "Add note"}
        </Button>
      </div>
    </form>
  )
}

export function SelectionBar(props: {
  label: string
  canAdd: boolean
  onAdd: () => void
  onClear: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-background px-3 py-1.5 font-sans text-xs text-muted-foreground">
      <span className="mr-auto">{props.label}</span>
      {props.canAdd && (
        <Button variant="outline" size="xs" onClick={props.onAdd}>
          <MessageSquarePlus data-icon="inline-start" aria-hidden />
          Add feedback
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Clear selected lines"
        onClick={props.onClear}
      >
        <X aria-hidden />
      </Button>
    </div>
  )
}

export function FeedbackOverview(props: {
  ready: boolean
  notes: ReadonlyArray<LineNote>
  changesId: string | null
  editingId: string | null
  editor: ReactNode
  onShow: (note: LineNote) => void
  onEdit: ((note: LineNote) => void) | null
  onRemove: (note: LineNote) => Promise<Problem | null>
}) {
  const { onEdit } = props

  if (!props.ready) return null

  if (props.notes.length === 0)
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        No feedback yet. Select lines in the diff, or drag the gutter +, to leave a Feedback note.
      </p>
    )

  return (
    <ul className="flex min-h-0 flex-col gap-2 overflow-y-auto p-3">
      {props.notes.map((note) => {
        const older = isOlder(note, props.changesId)

        return (
          <li key={note.id}>
            {props.editingId === note.id ? (
              props.editor
            ) : (
              <FeedbackNoteCard
                note={note}
                olderCode={older ? note.code : null}
                location={viewOf(note).location}
                onShow={older ? null : () => props.onShow(note)}
                onEdit={onEdit === null ? null : () => onEdit(note)}
                onRemove={() => props.onRemove(note)}
              />
            )}
          </li>
        )
      })}
    </ul>
  )
}

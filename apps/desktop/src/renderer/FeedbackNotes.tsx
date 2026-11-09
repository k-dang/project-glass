import { FeedbackNote } from "@glass/contracts"
import { cn } from "cn"
import { History, MessageSquarePlus, PenLine, Trash2, X } from "lucide-react"
import { type ReactNode, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { Textarea } from "@/components/ui/textarea"
import { type FeedbackTarget, isOlder, rangeLabel } from "./feedbackLines"
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

export function FeedbackNoteCard(props: {
  note: FeedbackNote
  older: boolean
  location: string
  onShow: (() => void) | null
  onEdit: (() => void) | null
  onRemove: () => Promise<Problem | null>
  foldedCode?: boolean
}) {
  const { note, older } = props
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
      aria-label={`Feedback on ${note.path} ${rangeLabel(note.side, note.start, note.end)}`}
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
        <span>· Unsent</span>
        {older && <OlderVersion />}
      </div>
      {older && <Snippet code={note.code} />}
      <p className="whitespace-pre-wrap wrap-anywhere">{note.text}</p>
      {props.foldedCode === true && !older && <OriginalCode code={note.code} />}
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

function OriginalCode(props: { code: string }) {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground">Original code</summary>
      <div className="pt-1">
        <Snippet code={props.code} />
      </div>
    </details>
  )
}

const noteLocation = (note: FeedbackNote) =>
  `${note.path} ${rangeLabel(note.side, note.start, note.end)}`

export function StagedFeedback(props: {
  notes: ReadonlyArray<FeedbackNote>
  onSave: (note: FeedbackNote) => Promise<Problem | null>
  onRemove: (noteId: string) => Promise<Problem | null>
}) {
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)

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
                target={note}
                older={false}
                saved
                draft={editing.draft}
                onDraftChange={(draft) => setEditing({ id: note.id, draft })}
                onSave={async (text) => {
                  // oxlint-disable-next-line typescript/no-misused-spread -- The fields go straight back into FeedbackNote.
                  const problem = await props.onSave(new FeedbackNote({ ...note, text }))

                  if (problem === null) setEditing(null)

                  return problem
                }}
                onCancel={() => setEditing(null)}
              />
            ) : (
              <FeedbackNoteCard
                note={note}
                older={false}
                location={noteLocation(note)}
                onShow={null}
                onEdit={
                  editing === null ? () => setEditing({ id: note.id, draft: note.text }) : null
                }
                onRemove={() => props.onRemove(note.id)}
                foldedCode
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
          <li key={note.id} className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">{noteLocation(note)}</span>
            <Snippet code={note.code} />
            <p className="whitespace-pre-wrap wrap-anywhere">{note.text}</p>
          </li>
        ))}
      </ul>
    </details>
  )
}

const focusOnMount = (element: HTMLTextAreaElement | null) => element?.focus()

export function FeedbackEditor(props: {
  target: FeedbackTarget
  older: boolean
  saved: boolean
  draft: string
  onDraftChange: (draft: string) => void
  onSave: (text: string) => Promise<Problem | null>
  onCancel: () => void
}) {
  const { target, older, saved, draft } = props
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
        <span>{rangeLabel(target.side, target.start, target.end)}</span>
        {older && <OlderVersion />}
      </div>
      {older && <Snippet code={target.code} />}
      <Textarea
        value={draft}
        ref={focusOnMount}
        aria-label="Feedback on selected code"
        placeholder="What should the Agent change here?"
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
  notes: ReadonlyArray<FeedbackNote>
  changesId: string | null
  editingId: string | null
  editor: ReactNode
  onShow: (note: FeedbackNote) => void
  onEdit: ((note: FeedbackNote) => void) | null
  onRemove: (note: FeedbackNote) => Promise<Problem | null>
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
                older={older}
                location={`${note.path} ${rangeLabel(note.side, note.start, note.end)}`}
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

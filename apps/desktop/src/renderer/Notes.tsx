import type { LineDiscussion } from "@glass/contracts"
import { Predicate } from "effect"
import { CircleCheck, MessageSquare, PenLine, Plus } from "lucide-react"
import type { MouseEvent, ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { LineLocation } from "./Discussions"
import { DraftLocation, draftBody, feedbackText, showDraft } from "./Drafts"
import { type ListedNote, type ShowNote, toNoteSections } from "./changesView"
import { type DraftStore, useDraftViews } from "./useDrafts"

const previews = new WeakMap<LineDiscussion, string>()

const preview = (discussion: LineDiscussion) => {
  let text = previews.get(discussion)

  if (text === undefined) {
    const html = discussion.comments[0].bodyHtml
    text = new DOMParser().parseFromString(html, "text/html").body.textContent?.trim() ?? ""
    previews.set(discussion, text)
  }

  return text
}

const unlessSelecting = (event: MouseEvent<HTMLElement>, show: () => void) => {
  const selection = window.getSelection()

  if (
    selection !== null &&
    !selection.isCollapsed &&
    event.currentTarget.contains(selection.anchorNode)
  ) {
    return
  }

  show()
}

function NoteRow(props: {
  icon: ReactNode
  location: ReactNode
  aside?: ReactNode
  text: ReactNode
  label: string
  onShow: () => void
}) {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        aria-label={props.label}
        onClick={(event) => unlessSelecting(event, props.onShow)}
        className="h-auto w-full items-start justify-start gap-2 rounded-none border-0 px-3 py-2 text-left font-normal whitespace-normal select-text hover:bg-accent"
      >
        <span className="mt-0.5 shrink-0">{props.icon}</span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">{props.location}</span>
            {props.aside}
          </span>
          <span className="line-clamp-2 break-words">{props.text}</span>
        </span>
      </Button>
    </li>
  )
}

function NoteItem(props: { path: string; note: ListedNote; show: ShowNote }) {
  const { path, note, show } = props

  if (note.type === "discussion") {
    const { discussion } = note
    const [first] = discussion.comments

    return (
      <NoteRow
        icon={
          discussion.resolved ? (
            <CircleCheck className="size-4 text-muted-foreground" aria-hidden />
          ) : (
            <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
          )
        }
        location={
          <>
            {first.author} on <LineLocation side={discussion.side} line={discussion.line} />
          </>
        }
        aside={discussion.resolved && <span>Resolved</span>}
        text={preview(discussion)}
        label={`Show Discussion on ${path} line ${discussion.line}`}
        onShow={() => show.line(path, discussion.side, discussion.line)}
      />
    )
  }

  const { draft } = note

  return (
    <NoteRow
      icon={<PenLine className="size-4 text-modified" aria-hidden />}
      location={
        <>
          {Predicate.isTagged(draft.place, "FlaggedPlace") ? "Flagged draft" : "Draft"} on{" "}
          <DraftLocation draft={draft} />
        </>
      }
      aside={feedbackText(draft.feedback)}
      text={draftBody(draft.body)}
      label={`Show Draft on ${path}`}
      onShow={() => showDraft(show, draft)}
    />
  )
}

export function NotesList(props: {
  paths: ReadonlyArray<string>
  discussions: ReadonlyArray<LineDiscussion>
  drafts: DraftStore
  show: ShowNote
}) {
  const drafts = useDraftViews(props.drafts)
  const sections = toNoteSections(props.paths, props.discussions, drafts)

  if (sections.length === 0) {
    return (
      <p className="px-6 py-8 text-center text-sm text-balance text-muted-foreground">
        No Discussions or Drafts on lines yet. Hover a line in Changes and choose{" "}
        <Plus className="inline size-3.5 align-[-2px]" aria-label="the plus button" /> to start a
        Draft.
      </p>
    )
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {sections.map(({ path, notes }) => (
        <section key={path} className="border-b">
          <h3>
            <Button
              type="button"
              variant="link"
              onClick={() => props.show.file(path)}
              title={`Show ${path} in Changes`}
              className="block h-auto w-full truncate rounded-none px-3 pt-3 pb-1 text-left font-mono text-xs font-normal text-muted-foreground hover:text-foreground"
            >
              {path}
            </Button>
          </h3>
          <ul className="pb-2">
            {notes.map((note) => (
              <NoteItem
                key={note.type === "draft" ? note.draft.key : note.discussion.id}
                path={path}
                note={note}
                show={props.show}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

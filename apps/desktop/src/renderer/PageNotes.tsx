import { isPageNote, PageNote, type PagePart } from "@glass/contracts"
import { HTML_PAGE_SANDBOX } from "@glass/contracts/desktop"
import { useAtomSet } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { MousePointerClick } from "lucide-react"
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { Toggle } from "@/components/ui/toggle"
import { pageNoteEditingAtom } from "./threadsArea"
import { FeedbackEditor, pagePartLabel, withText } from "./FeedbackNotes"
import { FromPage, type PageRect, type PageState } from "./pageMessages"
import { withPageNotes } from "./pageNotesScript"
import { useFeedbackNotes } from "./useFeedbackNotes"

const fromPage = Schema.decodeUnknownOption(FromPage)

const editorWidth = 320

const gap = 8

interface Editing {
  readonly part: PagePart
  readonly note: PageNote | null
  readonly draft: string
  readonly rect: PageRect
}

const sameRect = (a: PageRect, b: PageRect) =>
  a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right

const activeOf = (editing: boolean, noteId: string | null): PageState["active"] => {
  if (!editing) return null

  if (noteId === null) return { type: "draft" }

  return { type: "note", id: noteId }
}

function useHtmlPage(html: string) {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    const opened = window.glass.htmlPages.open(withPageNotes(html))

    void opened.then(setSrc)

    return () => {
      setSrc(null)
      void opened.then(window.glass.htmlPages.close)
    }
  }, [html])

  return src
}

// WARNING: The page runs in its own sandboxed origin, so files beside it don't load.
export function PageWithNotes(props: { threadId: string; path: string; html: string }) {
  const store = useFeedbackNotes(props.threadId)
  const src = useHtmlPage(props.html)
  const frame = useRef<HTMLIFrameElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const [pick, setPick] = useState(false)
  const [opened, setEditing] = useState<Editing | null>(null)
  const [loads, setLoads] = useState(0)

  const notes = useMemo(
    () => store.notes.filter(isPageNote).filter(({ path }) => path === props.path),
    [store.notes, props.path],
  )

  const openedNoteId = opened?.note?.id ?? null

  const editing =
    openedNoteId !== null && !notes.some(({ id }) => id === openedNoteId) ? null : opened

  const isEditing = editing !== null
  const editingNoteId = editing?.note?.id ?? null

  const setEditingOnPage = useAtomSet(pageNoteEditingAtom(props.threadId))

  useEffect(() => {
    setEditingOnPage(editingNoteId)

    return () => setEditingOnPage(null)
  }, [editingNoteId, setEditingOnPage])

  const state = useMemo(
    (): PageState => ({
      pick,
      notes: notes.map(({ id, part }) => ({ id, part })),
      active: activeOf(isEditing, editingNoteId),
    }),
    [pick, notes, isEditing, editingNoteId],
  )

  useEffect(() => {
    if (loads > 0) frame.current?.contentWindow?.postMessage({ glassPageState: state }, "*")
  }, [state, loads])

  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const element = area.current

    if (element === null) return undefined

    const observer = new ResizeObserver(() =>
      setSize({ width: element.clientWidth, height: element.clientHeight }),
    )

    observer.observe(element)

    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onMessage = (message: MessageEvent) => {
      if (message.source === null || message.source !== frame.current?.contentWindow) return

      const received = fromPage(message.data)

      if (Option.isNone(received)) return

      const value = received.value.glassPageEvent

      switch (value.type) {
        case "ready":
          setLoads((count) => count + 1)
          break
        case "part":
          setEditing({ part: value.part, note: null, draft: "", rect: value.rect })
          break
        case "open": {
          const note = notes.find(({ id }) => id === value.id)

          if (note !== undefined && !isEditing)
            setEditing({ part: note.part, note, draft: note.text, rect: value.rect })
          break
        }

        case "rect":
          setEditing(
            (current) =>
              current &&
              (sameRect(current.rect, value.rect) ? current : { ...current, rect: value.rect }),
          )
          break
        case "escape":
          if (isEditing) setEditing(null)
          else setPick(false)
          break
      }
    }

    window.addEventListener("message", onMessage)

    return () => window.removeEventListener("message", onMessage)
  }, [notes, isEditing])

  const save = async (current: Editing, text: string) => {
    const note =
      current.note === null
        ? new PageNote({ id: crypto.randomUUID(), path: props.path, part: current.part, text })
        : withText(current.note, text)

    const problem = await store.save(note)

    if (problem === null) setEditing(null)

    return problem
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape" && editing === null && pick) setPick(false)
  }

  return (
    <div role="presentation" className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate">
          {pick
            ? "Click part of the page to leave a Feedback note. Esc to stop."
            : "Select text, or pick an element, to leave a Feedback note."}
        </span>
        <Toggle variant="outline" size="sm" pressed={pick} onPressedChange={setPick}>
          <MousePointerClick data-icon="inline-start" aria-hidden />
          Pick element
        </Toggle>
      </div>
      <div ref={area} className="relative min-h-0 flex-1">
        {src !== null && (
          <iframe
            ref={frame}
            title={props.path}
            src={src}
            sandbox={HTML_PAGE_SANDBOX}
            className="absolute inset-0 size-full border-0 bg-white"
          />
        )}
        {editing !== null && (
          <div className="absolute z-10" style={placement(editing.rect, size)}>
            <FeedbackEditor
              place={pagePartLabel(editing.part)}
              about="page"
              olderCode={null}
              saved={editing.note !== null}
              draft={editing.draft}
              onDraftChange={(draft) => setEditing({ ...editing, draft })}
              onSave={(text) => save(editing, text)}
              onCancel={() => setEditing(null)}
            />
          </div>
        )}
      </div>
    </div>
  )
}

const placement = (rect: PageRect, area: { readonly width: number; readonly height: number }) => {
  const width = Math.min(editorWidth, area.width - gap * 2)
  const { height } = area
  const left = Math.max(gap, Math.min(rect.left, area.width - width - gap))

  if (rect.bottom + gap <= height * 0.6)
    return { left, width, top: Math.max(gap, rect.bottom + gap) }

  if (rect.top - gap >= height * 0.4) return { left, width, bottom: height - rect.top + gap }

  return { left, width, top: gap }
}

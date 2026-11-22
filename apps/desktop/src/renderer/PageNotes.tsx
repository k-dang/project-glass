import { useAtomSet } from "@effect/atom-react"
import {
  isPageNote,
  PageEvent,
  PageLocation,
  PageNote,
  type PagePart,
  PageRect,
  type PageState,
} from "@glass/contracts"
import { PAGE_EVENT_CHANNEL, PAGE_STATE_CHANNEL } from "@glass/contracts/desktop"
import { Option, Schema } from "effect"
import { useEffect, useEffectEvent, useMemo, useState } from "react"
import { createPortal } from "react-dom"
import { useBrowserPageFrame } from "./browserPages"
import { FeedbackEditor, pagePartLabel, withText } from "./FeedbackNotes"
import { pageNoteEditingAtom } from "./threadsArea"
import { useFeedbackNotes } from "./useFeedbackNotes"

const decodeEvent = Schema.decodeUnknownOption(PageEvent)

const sameRect = Schema.toEquivalence(PageRect)

const samePage = Schema.toEquivalence(PageLocation)

const sendState = (view: HTMLWebViewElement, state: PageState) =>
  view.send(PAGE_STATE_CHANNEL, state)

const editorWidth = 320

const gap = 8

interface Editing {
  readonly part: PagePart
  readonly note: PageNote | null
  readonly draft: string
  readonly rect: PageRect
}

const activeOf = (editing: boolean, noteId: string | null): PageState["active"] => {
  if (!editing) return null

  if (noteId === null) return { type: "draft" }

  return { type: "note", id: noteId }
}

export function PageNotes(props: {
  view: HTMLWebViewElement
  threadId: string
  page: PageLocation
  pick: boolean
  loads: number
  onStopPicking: () => void
}) {
  const { view, threadId, page, pick, loads } = props
  const store = useFeedbackNotes(threadId)
  const [opened, setEditing] = useState<Editing | null>(null)

  const notes = useMemo(
    () => store.notes.filter(isPageNote).filter((note) => samePage(note.page, page)),
    [store.notes, page],
  )

  const openedNoteId = opened?.note?.id ?? null

  const editing =
    openedNoteId !== null && !notes.some(({ id }) => id === openedNoteId) ? null : opened

  const isEditing = editing !== null
  const editingNoteId = editing?.note?.id ?? null

  const setEditingOnPage = useAtomSet(pageNoteEditingAtom(threadId))

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
    if (loads > 0) void sendState(view, state)
  }, [view, state, loads])

  const onMessage = useEffectEvent(
    (message: { readonly channel: string; readonly args: ReadonlyArray<unknown> }) => {
      if (message.channel !== PAGE_EVENT_CHANNEL) return

      const received = decodeEvent(message.args[0])

      if (Option.isNone(received)) return

      const value = received.value

      switch (value.type) {
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
          else props.onStopPicking()
          break
        case "ready":
          break
      }
    },
  )

  useEffect(() => {
    const receive = (message: {
      readonly channel: string
      readonly args: ReadonlyArray<unknown>
    }) => onMessage(message)

    view.addEventListener("ipc-message", receive)

    return () => {
      view.removeEventListener("ipc-message", receive)
    }
  }, [view])

  const frame = useBrowserPageFrame(threadId)

  const save = async (current: Editing, text: string) => {
    const note =
      current.note === null
        ? new PageNote({ id: crypto.randomUUID(), page, part: current.part, text })
        : withText(current.note, text)

    const problem = await store.save(note)

    if (problem === null) setEditing(null)

    return problem
  }

  if (editing === null || frame === null) return null

  return createPortal(
    <div className="pointer-events-none fixed z-20" style={frame}>
      <div className="pointer-events-auto absolute" style={placement(editing.rect, frame)}>
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
    </div>,
    document.body,
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

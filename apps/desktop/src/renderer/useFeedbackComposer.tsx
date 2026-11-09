import { FeedbackNote } from "@glass/contracts"
import type {
  AnnotationSide,
  CodeViewLineSelection,
  DiffLineAnnotation,
  SelectedLineRange,
} from "@pierre/diffs"
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react"
import type { DiffViewProps } from "./ChangedFilesView"
import { annotationSides, type ChangesLayout, sideOf } from "./changesView"
import {
  type FeedbackAnnotation,
  type FeedbackExtra,
  feedbackAnnotations,
  feedbackTarget,
  firstSelection,
  isOlder,
  nextSelection,
  rangeLabel,
} from "./feedbackLines"
import { FeedbackEditor, FeedbackNoteCard, FeedbackOverview, SelectionBar } from "./FeedbackNotes"
import type { FeedbackNotesStore } from "./useFeedbackNotes"

type NoteDraft = Omit<FeedbackNote, "text">

type Composer =
  | { readonly type: "idle" }
  | { readonly type: "selecting"; readonly path: string; readonly range: SelectedLineRange }
  | {
      readonly type: "editing"
      readonly note: NoteDraft
      readonly saved: boolean
      readonly draft: string
      readonly where: "diff" | "overview"
    }

const idle: Composer = { type: "idle" }

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  target.closest("textarea, input, button, [contenteditable]") !== null

const rangeOf = (note: NoteDraft): SelectedLineRange => ({
  start: note.start,
  end: note.end,
  side: annotationSides[note.side],
})

type FeedbackDiffProps = Required<
  Pick<
    DiffViewProps<FeedbackAnnotation>,
    | "annotationsFor"
    | "renderAnnotation"
    | "onCurrentPathChange"
    | "onGutterUtilityClick"
    | "selectedLines"
    | "onSelectedLinesChange"
  >
>

export function useFeedbackComposer(props: {
  changesId: string | null
  store: FeedbackNotesStore
  layout: ChangesLayout
  diffArea: RefObject<HTMLDivElement | null>
  reveal: (path: string, line: number, side: AnnotationSide, align: "center" | "nearest") => void
}) {
  const { changesId, store, layout, reveal, diffArea } = props
  const [composer, setComposer] = useState<Composer>(idle)
  const currentPath = useRef<string | null>(null)
  const editing = composer.type === "editing" ? composer : null

  const onCurrentPathChange = useCallback((path: string) => {
    currentPath.current = path
  }, [])

  const showNote = (note: NoteDraft) =>
    reveal(note.path, note.end, annotationSides[note.side], "center")

  const startNote = useCallback(
    (path: string, range: SelectedLineRange) => {
      if (editing !== null || changesId === null) return

      const fileDiff = layout.diffOf(path)
      const target = fileDiff === null || !store.ready ? null : feedbackTarget(fileDiff, range)

      setComposer(
        target === null
          ? { type: "selecting", path, range }
          : {
              type: "editing",
              note: { ...target, id: crypto.randomUUID(), path, changesId },
              saved: false,
              draft: "",
              where: "diff",
            },
      )
    },
    [editing, layout, store.ready, changesId],
  )

  const editNote = (note: FeedbackNote, where: "diff" | "overview") => {
    const older = isOlder(note, changesId)

    setComposer({
      type: "editing",
      note,
      saved: true,
      draft: note.text,
      where: older ? "overview" : where,
    })

    if (!older && where === "diff") showNote(note)
  }

  const save = async (note: NoteDraft, text: string) => {
    const problem = await store.save(new FeedbackNote({ ...note, text }))

    if (problem === null) setComposer(idle)

    return problem
  }

  const onSelectedLinesChange = useCallback(
    (next: CodeViewLineSelection | null) => {
      if (editing === null)
        setComposer(next === null ? idle : { type: "selecting", path: next.id, range: next.range })
    },
    [editing],
  )

  const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (editing !== null || isTyping(event.target)) return

    const selecting = composer.type === "selecting" ? composer : null

    if (event.key === "Escape" && selecting !== null) {
      event.preventDefault()
      setComposer(idle)

      return
    }

    if (event.key === "Enter" && selecting !== null) {
      event.preventDefault()
      startNote(selecting.path, selecting.range)

      return
    }

    if (!event.shiftKey || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return

    const path = selecting?.path ?? currentPath.current ?? layout.files[0]?.file.path
    const fileDiff = path === undefined ? null : layout.diffOf(path)

    if (path === undefined || fileDiff === null) return

    event.preventDefault()

    const range =
      selecting !== null && selecting.path === path
        ? nextSelection(fileDiff, selecting.range, event.key === "ArrowDown" ? 1 : -1)
        : firstSelection(fileDiff)

    if (range === null) return

    setComposer({ type: "selecting", path, range })
    reveal(path, range.end, range.endSide ?? range.side ?? "additions", "nearest")
  })

  useEffect(() => {
    const area = diffArea.current

    area?.addEventListener("keydown", onKeyDown)

    return () => area?.removeEventListener("keydown", onKeyDown)
  }, [diffArea])

  const selectedTarget = useMemo(() => {
    if (composer.type !== "selecting") return null

    const fileDiff = layout.diffOf(composer.path)

    return fileDiff === null ? null : feedbackTarget(fileDiff, composer.range)
  }, [layout, composer])

  const extra = useMemo((): FeedbackExtra | null => {
    if (composer.type === "selecting")
      return {
        type: "selection",
        path: composer.path,
        side: sideOf(composer.range.side),
        end: composer.range.end,
      }

    if (composer.type === "editing" && composer.where === "diff") {
      const { id, path, side, end } = composer.note

      return { type: "editor", id, path, side, end }
    }

    return null
  }, [composer])

  const annotationsFor = useMemo(
    () => feedbackAnnotations(store.notes, changesId, extra),
    [store.notes, changesId, extra],
  )

  const selectedLines = (): CodeViewLineSelection | null => {
    if (composer.type === "selecting") return { id: composer.path, range: composer.range }

    if (composer.type === "editing" && !isOlder(composer.note, changesId))
      return { id: composer.note.path, range: rangeOf(composer.note) }

    return null
  }

  const renderEditor = (current: Extract<Composer, { type: "editing" }>) => (
    <FeedbackEditor
      target={current.note}
      older={isOlder(current.note, changesId)}
      saved={current.saved}
      draft={current.draft}
      onDraftChange={(draft) => setComposer({ ...current, draft })}
      onSave={(text) => save(current.note, text)}
      onCancel={() => setComposer(idle)}
    />
  )

  const annotationContent = (metadata: FeedbackAnnotation): ReactNode => {
    if (metadata.type === "editor") return editing === null ? null : renderEditor(editing)

    if (metadata.type === "selection")
      return (
        <SelectionBar
          label={
            selectedTarget === null
              ? "Choose shown lines on one side of the diff."
              : rangeLabel(selectedTarget.side, selectedTarget.start, selectedTarget.end)
          }
          canAdd={selectedTarget !== null && store.ready}
          onAdd={() => composer.type === "selecting" && startNote(composer.path, composer.range)}
          onClear={() => setComposer(idle)}
        />
      )

    const note = store.notes.find(({ id }) => id === metadata.id)

    return note === undefined ? null : (
      <FeedbackNoteCard
        key={note.id}
        note={note}
        older={false}
        location={rangeLabel(note.side, note.start, note.end)}
        onShow={null}
        onEdit={editing === null ? () => editNote(note, "diff") : null}
        onRemove={() => store.remove(note.id)}
      />
    )
  }

  const renderAnnotation = ({ metadata }: DiffLineAnnotation<FeedbackAnnotation>) => {
    const content = annotationContent(metadata)

    return content === null ? null : <div className="px-3 py-2">{content}</div>
  }

  const diffProps: FeedbackDiffProps = {
    annotationsFor,
    renderAnnotation,
    onCurrentPathChange,
    onGutterUtilityClick: startNote,
    selectedLines: selectedLines(),
    onSelectedLinesChange,
  }

  const overview = (
    <FeedbackOverview
      ready={store.ready}
      notes={store.notes}
      changesId={changesId}
      editingId={editing?.where === "overview" ? editing.note.id : null}
      editor={editing === null ? null : renderEditor(editing)}
      onShow={showNote}
      onEdit={editing === null ? (note) => editNote(note, "overview") : null}
      onRemove={(note) => store.remove(note.id)}
    />
  )

  return { diffProps, overview }
}

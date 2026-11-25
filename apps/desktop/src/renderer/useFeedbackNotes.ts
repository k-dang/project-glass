import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type FeedbackNote, isLineNote, type LineNote } from "@glass/contracts"
import { type Effect, Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { feedbackNotesAtom, pageNoteEditingAtom, writtenFeedbackAtom } from "./threadsArea"
import { Backend, type BackendError, useBackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

interface NotesEditor<Note> {
  readonly ready: boolean
  readonly notes: ReadonlyArray<Note>
  readonly save: (note: Note) => Promise<Problem | null>
  readonly remove: (noteId: string) => Promise<Problem | null>
  readonly refresh: () => void
}

export type LineNotesEditor = NotesEditor<LineNote>

export interface FeedbackNotesStore extends NotesEditor<FeedbackNote> {
  readonly editingOnPage: boolean
  readonly sent: (noteIds: ReadonlyArray<string>) => void
}

export const lineNotesOf = (store: FeedbackNotesStore): LineNotesEditor => ({
  ready: store.ready,
  notes: store.notes.filter(isLineNote),
  save: store.save,
  remove: store.remove,
  refresh: store.refresh,
})

export const noteWriteTitles = {
  save: "Couldn't save your Feedback note",
  remove: "Couldn't remove your Feedback note",
}

export const notesWriter =
  <A>(runtime: ReturnType<typeof useBackendRuntime>, keep: (written: A) => void) =>
  async (title: string, call: Effect.Effect<A, BackendError, Backend>): Promise<Problem | null> => {
    const exit = await runtime.runPromiseExit(call)

    if (Exit.isFailure(exit)) return { ...problemOf(exit.cause), title }

    keep(exit.value)

    return null
  }

const noNotes: ReadonlyArray<FeedbackNote> = []

const without = (notes: ReadonlyArray<FeedbackNote>, noteIds: ReadonlyArray<string>) =>
  notes.filter(({ id }) => !noteIds.includes(id))

export function useFeedbackNotes(threadId: string): FeedbackNotesStore {
  const runtime = useBackendRuntime()
  const listed = useAtomValue(feedbackNotesAtom(threadId))
  const refetch = useAtomRefresh(feedbackNotesAtom(threadId))
  const [written, setWritten] = useAtom(writtenFeedbackAtom(threadId))
  const editingOnPage = useAtomValue(pageNoteEditingAtom(threadId)) !== null
  const saved = AsyncResult.isSuccess(listed) ? listed.value : null
  const notes = written ?? saved ?? noNotes

  return useMemo(() => {
    const write = notesWriter(runtime, setWritten)

    return {
      ready: saved !== null || written !== null,
      notes,
      editingOnPage,
      save: (note) =>
        write(
          noteWriteTitles.save,
          Backend.use((backend) => backend.SaveFeedbackNote({ threadId, note })),
        ),
      remove: (noteId) =>
        write(
          noteWriteTitles.remove,
          Backend.use((backend) => backend.RemoveFeedbackNote({ threadId, noteId })),
        ),
      sent: (noteIds) => setWritten((current) => without(current ?? saved ?? noNotes, noteIds)),
      refresh: () => {
        setWritten(null)
        refetch()
      },
    }
  }, [threadId, runtime, notes, saved, written, setWritten, refetch, editingOnPage])
}

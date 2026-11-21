import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type FeedbackNote, isLineNote, type LineNote, UnsentFeedback } from "@glass/contracts"
import { type Effect, Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { feedbackNotesAtom, pageNoteEditingAtom, writtenFeedbackAtom } from "./conversationsArea"
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
  readonly staged: ReadonlyArray<FeedbackNote>
  readonly editingOnPage: boolean
  readonly stage: () => Promise<Problem | null>
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

const noFeedback = new UnsentFeedback({ notes: [], staged: [] })

const without = (unsent: UnsentFeedback, noteIds: ReadonlyArray<string>) =>
  new UnsentFeedback({
    notes: unsent.notes.filter(({ id }) => !noteIds.includes(id)),
    staged: unsent.staged.filter((id) => !noteIds.includes(id)),
  })

export function useFeedbackNotes(conversationId: string): FeedbackNotesStore {
  const runtime = useBackendRuntime()
  const listed = useAtomValue(feedbackNotesAtom(conversationId))
  const refetch = useAtomRefresh(feedbackNotesAtom(conversationId))
  const [written, setWritten] = useAtom(writtenFeedbackAtom(conversationId))
  const editingOnPage = useAtomValue(pageNoteEditingAtom(conversationId)) !== null
  const saved = AsyncResult.isSuccess(listed) ? listed.value : null
  const unsent = written ?? saved ?? noFeedback

  return useMemo(() => {
    const write = notesWriter(runtime, setWritten)

    return {
      ready: saved !== null || written !== null,
      notes: unsent.notes,
      staged: unsent.notes.filter(({ id }) => unsent.staged.includes(id)),
      editingOnPage,
      save: (note) =>
        write(
          noteWriteTitles.save,
          Backend.use((backend) => backend.SaveFeedbackNote({ conversationId, note })),
        ),
      remove: (noteId) =>
        write(
          noteWriteTitles.remove,
          Backend.use((backend) => backend.RemoveFeedbackNote({ conversationId, noteId })),
        ),
      stage: () =>
        write(
          "Couldn't add your feedback to the message",
          Backend.use((backend) => backend.StageFeedbackNotes({ conversationId })),
        ),
      sent: (noteIds) => setWritten((current) => without(current ?? saved ?? noFeedback, noteIds)),
      refresh: () => {
        setWritten(null)
        refetch()
      },
    }
  }, [conversationId, runtime, unsent, saved, written, setWritten, refetch, editingOnPage])
}

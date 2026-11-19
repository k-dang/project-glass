import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { type Effect, Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { feedbackNotesAtom, writtenFeedbackAtom } from "./conversationsArea"
import { Backend, type BackendError, useBackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export interface FeedbackNotesEditor {
  readonly ready: boolean
  readonly notes: ReadonlyArray<FeedbackNote>
  readonly save: (note: FeedbackNote) => Promise<Problem | null>
  readonly remove: (noteId: string) => Promise<Problem | null>
  readonly refresh: () => void
}

export interface FeedbackNotesStore extends FeedbackNotesEditor {
  readonly staged: ReadonlyArray<FeedbackNote>
  readonly stage: () => Promise<Problem | null>
  readonly sent: (noteIds: ReadonlyArray<string>) => void
}

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
  const saved = AsyncResult.isSuccess(listed) ? listed.value : null
  const unsent = written ?? saved ?? noFeedback

  return useMemo(() => {
    const write = notesWriter(runtime, setWritten)

    return {
      ready: saved !== null || written !== null,
      notes: unsent.notes,
      staged: unsent.notes.filter(({ id }) => unsent.staged.includes(id)),
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
  }, [conversationId, runtime, unsent, saved, written, setWritten, refetch])
}

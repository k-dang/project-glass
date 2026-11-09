import { useAtom, useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type FeedbackNote, UnsentFeedback } from "@glass/contracts"
import { type Effect, Exit } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo } from "react"
import { feedbackNotesAtom, writtenFeedbackAtom } from "./agentsArea"
import { Backend, type BackendError, useBackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export interface FeedbackNotesStore {
  readonly ready: boolean
  readonly notes: ReadonlyArray<FeedbackNote>
  readonly staged: ReadonlyArray<FeedbackNote>
  readonly save: (note: FeedbackNote) => Promise<Problem | null>
  readonly remove: (noteId: string) => Promise<Problem | null>
  readonly stage: () => Promise<Problem | null>
  readonly sent: (noteIds: ReadonlyArray<string>) => void
  readonly refresh: () => void
}

const nothingUnsent = new UnsentFeedback({ notes: [], staged: [] })

const withSaved = (notes: ReadonlyArray<FeedbackNote>, saved: FeedbackNote) =>
  notes.some(({ id }) => id === saved.id)
    ? notes.map((note) => (note.id === saved.id ? saved : note))
    : [...notes, saved]

const without = (unsent: UnsentFeedback, noteIds: ReadonlyArray<string>) =>
  new UnsentFeedback({
    notes: unsent.notes.filter(({ id }) => !noteIds.includes(id)),
    staged: unsent.staged.filter((id) => !noteIds.includes(id)),
  })

export function useFeedbackNotes(agentId: string): FeedbackNotesStore {
  const runtime = useBackendRuntime()
  const listed = useAtomValue(feedbackNotesAtom(agentId))
  const refetch = useAtomRefresh(feedbackNotesAtom(agentId))
  const [written, setWritten] = useAtom(writtenFeedbackAtom(agentId))
  const saved = AsyncResult.isSuccess(listed) ? listed.value : null
  const unsent = written ?? saved ?? nothingUnsent

  return useMemo(() => {
    const write = async (
      title: string,
      call: Effect.Effect<void, BackendError, Backend>,
      apply: (unsent: UnsentFeedback) => UnsentFeedback,
    ) => {
      const exit = await runtime.runPromiseExit(call)

      if (Exit.isFailure(exit)) return { ...problemOf(exit.cause), title }

      setWritten((current) => apply(current ?? saved ?? nothingUnsent))

      return null
    }

    return {
      ready: saved !== null || written !== null,
      notes: unsent.notes,
      staged: unsent.notes.filter(({ id }) => unsent.staged.includes(id)),
      save: (note) =>
        write(
          "Couldn't save your Feedback note",
          Backend.use((backend) => backend.SaveFeedbackNote({ agentId, note })),
          (current) =>
            new UnsentFeedback({ notes: withSaved(current.notes, note), staged: current.staged }),
        ),
      remove: (noteId) =>
        write(
          "Couldn't remove your Feedback note",
          Backend.use((backend) => backend.RemoveFeedbackNote({ agentId, noteId })),
          (current) => without(current, [noteId]),
        ),
      stage: () => {
        const noteIds = unsent.notes.map(({ id }) => id)

        return write(
          "Couldn't add your feedback to the message",
          Backend.use((backend) => backend.StageFeedbackNotes({ agentId, noteIds })),
          (current) => new UnsentFeedback({ notes: current.notes, staged: noteIds }),
        )
      },
      sent: (noteIds) =>
        setWritten((current) => without(current ?? saved ?? nothingUnsent, noteIds)),
      refresh: () => {
        setWritten(null)
        refetch()
      },
    }
  }, [agentId, runtime, unsent, saved, written, setWritten, refetch])
}

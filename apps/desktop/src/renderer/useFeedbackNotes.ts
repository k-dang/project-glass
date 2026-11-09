import type { FeedbackNote } from "@glass/contracts"
import { type Effect, Exit } from "effect"
import { useMemo, useState } from "react"
import { Backend, type BackendError, useBackendRuntime } from "./backend"
import { type Problem, problemOf } from "./problems"

export interface FeedbackNotesStore {
  readonly ready: boolean
  readonly notes: ReadonlyArray<FeedbackNote>
  readonly save: (note: FeedbackNote) => Promise<Problem | null>
  readonly remove: (noteId: string) => Promise<Problem | null>
}

const withSaved = (notes: ReadonlyArray<FeedbackNote>, saved: FeedbackNote) =>
  notes.some(({ id }) => id === saved.id)
    ? notes.map((note) => (note.id === saved.id ? saved : note))
    : [...notes, saved]

const noNotes: ReadonlyArray<FeedbackNote> = []

export function useFeedbackNotes(
  agentId: string,
  saved: ReadonlyArray<FeedbackNote> | null,
): FeedbackNotesStore {
  const runtime = useBackendRuntime()
  const [written, setWritten] = useState<ReadonlyArray<FeedbackNote> | null>(null)
  const notes = written ?? saved ?? noNotes

  return useMemo(() => {
    const write = async (
      title: string,
      call: Effect.Effect<void, BackendError, Backend>,
      apply: (notes: ReadonlyArray<FeedbackNote>) => ReadonlyArray<FeedbackNote>,
    ) => {
      const exit = await runtime.runPromiseExit(call)

      if (Exit.isFailure(exit)) return { ...problemOf(exit.cause), title }

      setWritten((current) => apply(current ?? saved ?? noNotes))

      return null
    }

    return {
      ready: saved !== null,
      notes,
      save: (note) =>
        write(
          "Couldn't save your Feedback note",
          Backend.use((backend) => backend.SaveFeedbackNote({ agentId, note })),
          (current) => withSaved(current, note),
        ),
      remove: (noteId) =>
        write(
          "Couldn't remove your Feedback note",
          Backend.use((backend) => backend.RemoveFeedbackNote({ agentId, noteId })),
          (current) => current.filter(({ id }) => id !== noteId),
        ),
    }
  }, [agentId, runtime, notes, saved])
}

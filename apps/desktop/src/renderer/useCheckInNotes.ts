import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { LineNote } from "@glass/contracts"
import { Atom, AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { Backend, backendRuntime, useBackendRuntime } from "./backend"
import { type LineNotesEditor, notesWriter, noteWriteTitles } from "./useFeedbackNotes"

export const checkInChangesAtom = Atom.family((checkInId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.GetCheckInChanges({ checkInId }))),
)

export const checkInNotesAtom = Atom.family((checkInId: string) =>
  backendRuntime.atom(Backend.use((backend) => backend.ListCheckInNotes({ checkInId }))),
)

export function useCheckInNotes(checkInId: string): LineNotesEditor {
  const runtime = useBackendRuntime()
  const listed = useAtomValue(checkInNotesAtom(checkInId))
  const refetch = useAtomRefresh(checkInNotesAtom(checkInId))
  const [written, setWritten] = useState<ReadonlyArray<LineNote> | null>(null)
  const saved = AsyncResult.isSuccess(listed) ? listed.value : null

  return useMemo(() => {
    const write = notesWriter(runtime, setWritten)

    return {
      ready: saved !== null || written !== null,
      notes: written ?? saved ?? [],
      save: (note) =>
        write(
          noteWriteTitles.save,
          Backend.use((backend) => backend.SaveCheckInNote({ checkInId, note })),
        ),
      remove: (noteId) =>
        write(
          noteWriteTitles.remove,
          Backend.use((backend) => backend.RemoveCheckInNote({ checkInId, noteId })),
        ),
      refresh: () => {
        setWritten(null)
        refetch()
      },
    }
  }, [checkInId, runtime, saved, written, refetch])
}

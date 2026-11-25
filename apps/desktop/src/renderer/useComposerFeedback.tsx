import type { ThreadMessageInput, MessageInput } from "@glass/contracts"
import { useState } from "react"
import { type AttachedEdit, AttachedFeedback } from "./FeedbackNotes"
import type { FeedbackNotesStore } from "./useFeedbackNotes"

export function useComposerFeedback(
  store: FeedbackNotesStore | undefined,
  send: (message: ThreadMessageInput) => Promise<boolean>,
  steer: (message: MessageInput) => Promise<boolean>,
) {
  const [editing, setEditing] = useState<AttachedEdit | null>(null)

  if (store === undefined || store.notes.length === 0)
    return {
      editing: false,
      send: (message: MessageInput) => send({ ...message, feedback: [] }),
      steer,
    }

  const { notes } = store
  const included = notes.map(({ id }) => id)
  const open = editing !== null && included.includes(editing.id) ? editing : null

  return {
    editing: open !== null || store.editingOnPage,
    send: async (message: MessageInput) => {
      const accepted = await send({ ...message, feedback: included })

      if (accepted) store.sent(included)
      else store.refresh()

      return accepted
    },
    steer: null,
    holdUntilAccepted: true,
    allowEmpty: true,
    attachment: (
      <AttachedFeedback
        notes={notes}
        editing={open}
        onEditingChange={setEditing}
        onSave={store.save}
        onRemove={store.remove}
      />
    ),
  }
}

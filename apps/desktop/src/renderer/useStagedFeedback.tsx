import type { AgentMessageInput, MessageInput } from "@glass/contracts"
import { useState } from "react"
import { type StagedEdit, StagedFeedback } from "./FeedbackNotes"
import type { FeedbackNotesStore } from "./useFeedbackNotes"

export function useStagedFeedback(
  store: FeedbackNotesStore | undefined,
  send: (message: AgentMessageInput) => Promise<boolean>,
  steer: (message: MessageInput) => Promise<boolean>,
) {
  const [editing, setEditing] = useState<StagedEdit | null>(null)

  if (store === undefined || store.staged.length === 0)
    return {
      editing: false,
      send: (message: MessageInput) => send({ ...message, feedback: [] }),
      steer,
    }

  const { staged } = store
  const included = staged.map(({ id }) => id)
  const open = editing !== null && included.includes(editing.id) ? editing : null

  return {
    editing: open !== null,
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
      <StagedFeedback
        notes={staged}
        editing={open}
        onEditingChange={setEditing}
        onSave={store.save}
        onRemove={store.remove}
      />
    ),
  }
}

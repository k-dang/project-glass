import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { type Conversation, ConversationChanges as Changes, type Turn } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { FileDiff, MessageSquareText } from "lucide-react"
import { useMemo, useState } from "react"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  ChangesWithFeedback,
  LoadProblem,
  type SidebarTab,
  useNoteOpen,
} from "./ChangesWithFeedback"
import { conversationChangesAtom, feedbackNotesAtom } from "./conversationsArea"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import type { Problem } from "./problems"
import { type FeedbackNotesStore, lineNotesOf, useFeedbackNotes } from "./useFeedbackNotes"

export function ConversationChanges(props: {
  conversation: Conversation
  turns: ReadonlyArray<Turn>
  onReviewFeedback: () => void
}) {
  const { conversation } = props
  const changes = useAtomValue(conversationChangesAtom(conversation.id))
  const refresh = useAtomRefresh(conversationChangesAtom(conversation.id))
  const notes = useAtomValue(feedbackNotesAtom(conversation.id))
  const lastEnded = props.turns.findLast((turn) => turn.ended !== null)?.id ?? null
  const [lastEndedAtSnapshot, setLastEndedAtSnapshot] = useState(lastEnded)

  const shown: Changes | "loading" | "unavailable" = Option.getOrElse(
    AsyncResult.value(changes),
    () => (AsyncResult.isFailure(changes) ? "unavailable" : "loading"),
  )

  const store = useFeedbackNotes(conversation.id)
  const lineNotes = useMemo(() => lineNotesOf(store), [store])
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files")

  const showLatest = () => {
    setLastEndedAtSnapshot(lastEnded)
    refresh()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b px-6 py-2.5 text-sm text-muted-foreground">
        Changes since {conversation.baseBranch}, including uncommitted work
      </p>
      {lastEnded !== lastEndedAtSnapshot && (
        <div className="border-b px-6 py-3">
          <Alert role="note">
            <FileDiff aria-hidden />
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48">
                The Conversation has worked since you opened these changes.
              </span>
              <Button variant="outline" size="sm" onClick={showLatest}>
                Show latest
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
      <LoadProblem result={changes} retry={refresh} />
      <LoadProblem result={notes} retry={store.refresh} />
      {(shown !== "unavailable" || store.ready) && (
        <ChangesWithFeedback
          key={shown instanceof Changes ? shown.id : shown}
          changes={shown}
          store={lineNotes}
          sidebarTab={sidebarTab}
          setSidebarTab={setSidebarTab}
          footer={
            lineNotes.notes.length > 0 && (
              <ReviewFeedback
                count={lineNotes.notes.length}
                store={store}
                onStaged={props.onReviewFeedback}
              />
            )
          }
        />
      )}
    </div>
  )
}

function ReviewFeedback(props: { count: number; store: FeedbackNotesStore; onStaged: () => void }) {
  const { store } = props
  const editing = useNoteOpen()
  const [staging, setStaging] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)

  const stage = async () => {
    setStaging(true)
    const failed = await store.stage()
    setStaging(false)
    setProblem(failed)

    if (failed === null) props.onStaged()
  }

  return (
    <div className="flex flex-col gap-2 border-t px-4 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
        <span className="min-w-0 flex-1 basis-48">
          {editing
            ? "Save or cancel the open note before you review your feedback."
            : `${plural(props.count, "Feedback note")} to send to the Conversation.`}
        </span>
        <Button size="sm" disabled={editing || staging} onClick={() => void stage()}>
          <MessageSquareText data-icon="inline-start" aria-hidden />
          Review feedback
        </Button>
      </div>
      {problem !== null && (
        <ProblemAlert problem={problem} action={{ label: "Retry", run: () => void stage() }} />
      )}
    </div>
  )
}

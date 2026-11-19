import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { CheckIn, type CheckInAnswer, CheckInApprove, CheckInSendFeedback } from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Exit, Option, Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useId, useState } from "react"
import { ArrowLeft } from "lucide-react"
import { Button } from "@/components/ui/button"
import { TooltipHint } from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Backend, useBackendRuntime } from "./backend"
import {
  ChangesWithFeedback,
  LoadProblem,
  type SidebarTab,
  useNoteOpen,
} from "./ChangesWithFeedback"
import { useMinuteClock } from "./Inbox"
import { fileName } from "./fileName"
import { summaryParts, titleOf, Waited } from "./inboxItem"
import { watchedNeedsYouAtom } from "./needsYou"
import { plural } from "./plural"
import { type Problem, problemOf } from "./problems"
import { checkInChangesAtom, checkInNotesAtom, useCheckInNotes } from "./useCheckInNotes"
import { useShortcuts } from "./useShortcuts"

export function CheckInPage(props: { checkInId: string }) {
  const navigate = useNavigate()
  const needsYou = useAtomValue(watchedNeedsYouAtom)
  const backToInbox = () => void navigate({ to: "/inbox" })

  useShortcuts([{ key: "Escape", run: backToInbox }])

  const checkIn = Option.flatMap(AsyncResult.value(needsYou), (items) =>
    Option.fromNullishOr(items.filter(Schema.is(CheckIn)).find(({ id }) => id === props.checkInId)),
  )

  return (
    <main aria-label="Check-in" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {Option.isSome(checkIn) ? (
        <CheckInReview checkIn={checkIn.value} onBack={backToInbox} />
      ) : AsyncResult.isSuccess(needsYou) ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            This Check-in isn't waiting anymore: it was answered, or its wait ended.
          </p>
          <BackToInbox onBack={backToInbox} />
        </div>
      ) : null}
    </main>
  )
}

function BackToInbox(props: { onBack: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={props.onBack}
      aria-keyshortcuts="Escape"
      title="Back to Inbox (Esc)"
    >
      Back to Inbox
    </Button>
  )
}

function CheckInReview(props: { checkIn: CheckIn; onBack: () => void }) {
  const { checkIn } = props
  const changes = useAtomValue(checkInChangesAtom(checkIn.id))
  const refresh = useAtomRefresh(checkInChangesAtom(checkIn.id))
  const notes = useAtomValue(checkInNotesAtom(checkIn.id))
  const store = useCheckInNotes(checkIn.id)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("files")
  const shown = Option.getOrNull(AsyncResult.value(changes))
  const details = summaryParts(checkIn.summary)?.details ?? ""
  const now = useMinuteClock()

  return (
    <>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-sm">
        <TooltipHint content="Back to Inbox (Esc)">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Back to Inbox"
            aria-keyshortcuts="Escape"
            onClick={props.onBack}
          >
            <ArrowLeft aria-hidden />
          </Button>
        </TooltipHint>
        <h1 className="min-w-0 truncate font-medium" title={titleOf(checkIn)}>
          {titleOf(checkIn)}
        </h1>
        <p className="flex min-w-0 flex-1 items-center gap-1.5 text-muted-foreground">
          <span className="truncate" title={checkIn.folder}>
            {fileName(checkIn.folder)}
          </span>
          {shown !== null && (
            <span
              className="shrink-0"
              title="Includes uncommitted work, as it was when the agent checked in"
            >
              · since {shown.baseRef}
            </span>
          )}
          <span className="shrink-0">· {checkIn.askedBy} ·</span>
          <Waited since={checkIn.since} now={now} />
        </p>
      </header>
      {details !== "" && (
        <p className="border-b px-4 py-2 text-sm whitespace-pre-wrap text-pretty break-words">
          {details}
        </p>
      )}
      <LoadProblem result={changes} retry={refresh} />
      <LoadProblem result={notes} retry={store.refresh} />
      {shown !== null && (
        <ChangesWithFeedback
          changes={shown}
          store={store}
          sidebarTab={sidebarTab}
          setSidebarTab={setSidebarTab}
          footer={
            <AnswerBar
              checkInId={checkIn.id}
              noteCount={store.notes.length}
              onAnswered={props.onBack}
            />
          }
        />
      )}
    </>
  )
}

const answerHint = (editing: boolean, noteCount: number) => {
  if (editing) return "Save or cancel the open note before you answer."

  if (noteCount === 0) return "Select lines in the diff to leave a Feedback note."

  return `${plural(noteCount, "Feedback note")} ${noteCount === 1 ? "goes" : "go"} back with your answer. On an approval, notes are guidance, not a request for changes.`
}

function AnswerBar(props: { checkInId: string; noteCount: number; onAnswered: () => void }) {
  const editing = useNoteOpen()
  const runtime = useBackendRuntime()
  const [text, setText] = useState("")
  const [answering, setAnswering] = useState(false)
  const [problem, setProblem] = useState<Problem | null>(null)
  const messageId = useId()
  const typed = text.trim()
  const message = typed === "" ? null : typed
  const busy = editing || answering

  const answer = async (given: CheckInAnswer) => {
    setAnswering(true)

    const exit = await runtime.runPromiseExit(
      Backend.use((backend) =>
        backend.AnswerCheckIn({ checkInId: props.checkInId, answer: given }),
      ),
    )

    setAnswering(false)

    if (Exit.isSuccess(exit)) props.onAnswered()
    else setProblem(problemOf(exit.cause))
  }

  return (
    <form
      className="flex flex-col gap-2 border-t px-4 py-2"
      onSubmit={(event) => {
        event.preventDefault()
        void answer(CheckInSendFeedback.make({ message }))
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Label htmlFor={messageId} className="sr-only">
          Message to the agent
        </Label>
        <Input
          id={messageId}
          className="min-w-0 flex-1 basis-48"
          placeholder="Message to the agent (optional)"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => void answer(CheckInApprove.make({ message }))}
        >
          Approve
        </Button>
        <Button type="submit" disabled={busy || (props.noteCount === 0 && message === null)}>
          Send feedback
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{answerHint(editing, props.noteCount)}</p>
      {problem !== null && (
        <p role="alert" className="text-xs text-destructive">
          {problem.detail}
        </p>
      )}
    </form>
  )
}

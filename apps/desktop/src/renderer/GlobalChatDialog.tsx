import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  emptyTranscript,
  type EndedGlobalChatSession,
  isWaiting,
  localPlace,
  type ModelChoice,
  type QueuedMessage,
  StartFreshRefused,
  type Turn,
} from "@glass/contracts"
import { Cause, Data, DateTime, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowLeft, History, SquarePen, X } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { placeKey } from "./threadsArea"
import { ThreadComposer, contextLabel, Transcript } from "./ThreadView"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ThreadAtomsContext } from "./thread"
import {
  capturedContextAtom,
  changeGlobalModelAtom,
  endedSessionsAtom,
  globalChat,
  globalChatOpenAtom,
  globalModelAtom,
  globalUnseenAtom,
  loadEarlierInSessionAtom,
  markGlobalTurnSeenAtom,
  sessionTranscriptAtom,
  startGlobalFreshAtom,
} from "./globalChat"
import { ModelPicker } from "./ModelPicker"
import { ProblemAlert } from "./ProblemAlert"
import { describeError, settledProblem, streamProblem } from "./problems"
import { useWindowFocused } from "./useWindowFocused"

function GlobalModelPicker(props: { choice: ModelChoice }) {
  const change = useAtomSet(changeGlobalModelAtom)

  return (
    <ModelPicker
      harness="pi"
      placeKey={placeKey(localPlace)}
      model={props.choice.model}
      effort={props.choice.effort}
      onChange={change}
    />
  )
}

type Showing = Data.TaggedEnum<{
  Current: {}
  EndedSessions: {}
  EndedSession: { readonly session: EndedGlobalChatSession }
}>

const Showing = Data.taggedEnum<Showing>()

const showingCurrent = Showing.Current()

export function GlobalChatDialog() {
  const [open, setOpen] = useAtom(globalChatOpenAtom)
  const [showing, setShowing] = useState<Showing>(showingCurrent)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)

        if (!next) setShowing(showingCurrent)
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(48rem,calc(100vh-4rem))] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <ThreadAtomsContext value={globalChat}>
          <Shown showing={showing} show={setShowing} />
        </ThreadAtomsContext>
      </DialogContent>
    </Dialog>
  )
}

function Shown(props: { showing: Showing; show: (showing: Showing) => void }) {
  const { show } = props

  return Showing.$match(props.showing, {
    Current: () => <GlobalChat onShowEnded={() => show(Showing.EndedSessions())} />,
    EndedSessions: () => (
      <EndedSessions
        onBack={() => show(showingCurrent)}
        onOpen={(session) => show(Showing.EndedSession({ session }))}
      />
    ),
    EndedSession: ({ session }) => (
      <EndedSession session={session} onBack={() => show(Showing.EndedSessions())} />
    ),
  })
}

function Header(props: { title: string; onBack?: () => void; children?: ReactNode }) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
      {props.onBack !== undefined && (
        <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={props.onBack}>
          <ArrowLeft aria-hidden />
        </Button>
      )}
      <DialogTitle className="flex-1 truncate">{props.title}</DialogTitle>
      {props.children}
      <DialogClose
        render={<Button variant="ghost" size="icon-sm" aria-label="Close the Global chat" />}
      >
        <X aria-hidden />
      </DialogClose>
    </header>
  )
}

function PaddedProblem(props: Parameters<typeof ProblemAlert>[0]) {
  return (
    <div className="px-6 pt-4">
      <ProblemAlert {...props} />
    </div>
  )
}

const freshBlocked = (
  turns: ReadonlyArray<Turn>,
  queued: ReadonlyArray<QueuedMessage>,
): StartFreshRefused["reason"] | null => {
  const last = turns.at(-1)

  if (last?.parts.some(isWaiting)) return "waiting"

  if (last?.ended === null) return "running"

  if (queued.length > 0) return "queued"

  return null
}

const refusedFresh = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) &&
  Predicate.isTagged(Option.getOrNull(Cause.findErrorOption(result.cause)), "StartFreshRefused")

function StartFreshButton(props: {
  blocked: StartFreshRefused["reason"] | null
  pending: boolean
  onClick: () => void
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Start fresh"
      disabled={props.blocked !== null || props.pending}
      onClick={props.onClick}
    >
      <SquarePen aria-hidden />
    </Button>
  )

  if (props.blocked === null) return button

  const reason = describeError(new StartFreshRefused({ reason: props.blocked })).detail

  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        {button}
        <span className="sr-only">{reason}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

function GlobalChat(props: { onShowEnded: () => void }) {
  const transcript = useAtomValue(globalChat.transcript)
  const reconnect = useAtomRefresh(globalChat.transcript)
  const choice = Option.getOrNull(AsyncResult.value(useAtomValue(globalModelAtom)))
  const changed = useAtomValue(changeGlobalModelAtom)
  const context = useAtomValue(capturedContextAtom)
  const markSeen = useAtomSet(markGlobalTurnSeenAtom)
  const focused = useWindowFocused()
  const unseen = Option.getOrNull(AsyncResult.value(useAtomValue(globalUnseenAtom)))
  const [started, startFresh] = useAtom(startGlobalFreshAtom)
  const [confirming, setConfirming] = useState(false)

  const { turns, earlierTurns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const loadEarlier = useAtomSet(globalChat.loadEarlier)
  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && unseen !== null && endedAt !== undefined) markSeen(endedAt)
  }, [markSeen, focused, unseen, endedAt])

  const startProblem = refusedFresh(started) ? null : settledProblem(started)

  return (
    <>
      <Header title="Global chat">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Earlier Sessions"
          onClick={props.onShowEnded}
        >
          <History aria-hidden />
        </Button>
        <StartFreshButton
          blocked={freshBlocked(turns, queued)}
          pending={started.waiting}
          onClick={() => setConfirming(true)}
        />
      </Header>
      {AsyncResult.isFailure(transcript) && !transcript.waiting && (
        <PaddedProblem
          problem={streamProblem(transcript.cause)}
          action={{ label: "Reconnect", run: reconnect }}
        />
      )}
      {startProblem !== null && <PaddedProblem problem={startProblem} />}
      <Transcript
        turns={turns}
        earlierTurns={earlierTurns}
        onShowEarlier={loadEarlier}
        status={status}
      />
      <p className="truncate px-6 pb-1 text-xs text-muted-foreground">
        {context === null ? "No PR or Thread in view" : `Sends with ${contextLabel(context)}`}
      </p>
      <ThreadComposer
        turns={turns}
        queued={queued}
        idlePlaceholder="Ask Glass about your work"
        problem={settledProblem(changed)}
        pickers={choice !== null && <GlobalModelPicker choice={choice} />}
      />
      <ConfirmationDialog
        open={confirming}
        title="Start fresh?"
        description="Your next message starts a new Session. This one moves to Earlier Sessions."
        confirmLabel="Start fresh"
        confirmVariant="default"
        onConfirm={() => {
          setConfirming(false)
          startFresh()
        }}
        onCancel={() => setConfirming(false)}
      />
    </>
  )
}

const shortDate = (at: DateTime.Utc) =>
  DateTime.toDate(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })

const spanOf = ({ startedAt, endedAt }: EndedGlobalChatSession) =>
  `${shortDate(startedAt)} – ${shortDate(endedAt)}`

function EndedSessions(props: {
  onBack: () => void
  onOpen: (session: EndedGlobalChatSession) => void
}) {
  const ended = useAtomValue(endedSessionsAtom)
  const problem = settledProblem(ended)
  const sessions = Option.getOrElse(AsyncResult.value(ended), () => [])

  return (
    <>
      <Header title="Earlier Sessions" onBack={props.onBack} />
      <div className="flex-1 overflow-y-auto p-2">
        {problem !== null && <ProblemAlert problem={problem} />}
        {AsyncResult.isSuccess(ended) && sessions.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Sessions you end with Start fresh appear here.
          </p>
        )}
        <ul>
          {sessions.map((session) => (
            <li key={session.id}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => props.onOpen(session)}
              >
                {spanOf(session)}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function EndedSession(props: { session: EndedGlobalChatSession; onBack: () => void }) {
  const read = useAtomValue(sessionTranscriptAtom(props.session.id))
  const loadEarlier = useAtomSet(loadEarlierInSessionAtom(props.session.id))

  const { turns, earlierTurns, status } = Option.getOrElse(
    AsyncResult.value(read),
    () => emptyTranscript,
  )

  return (
    <>
      <Header title={spanOf(props.session)} onBack={props.onBack} />
      {AsyncResult.isFailure(read) && !read.waiting && (
        <PaddedProblem problem={streamProblem(read.cause)} />
      )}
      <Transcript
        turns={turns}
        earlierTurns={earlierTurns}
        onShowEarlier={loadEarlier}
        status={status}
      />
    </>
  )
}

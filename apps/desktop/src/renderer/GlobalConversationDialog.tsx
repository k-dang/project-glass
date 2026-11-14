import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  emptyTranscript,
  isWaiting,
  localPlace,
  type ModelChoice,
  type PastConversation,
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
import { placeKey } from "./agentsArea"
import { AgentComposer, contextLabel, Transcript } from "./AgentView"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ConversationContext } from "./conversation"
import {
  capturedContextAtom,
  changeGlobalModelAtom,
  globalConversation,
  globalConversationOpenAtom,
  globalModelAtom,
  globalUnseenAtom,
  markGlobalTurnSeenAtom,
  pastGlobalConversationsAtom,
  pastGlobalTranscriptAtom,
  startGlobalFreshAtom,
} from "./globalConversation"
import { ModelPicker } from "./ModelPicker"
import { ProblemAlert } from "./ProblemAlert"
import { describeError, settledProblem, streamProblem } from "./problems"
import { useWindowFocused } from "./useWindowFocused"

function GlobalModelPicker(props: { choice: ModelChoice }) {
  const change = useAtomSet(changeGlobalModelAtom)

  return (
    <ModelPicker
      engine="pi"
      placeKey={placeKey(localPlace)}
      model={props.choice.model}
      effort={props.choice.effort}
      onChange={change}
    />
  )
}

type Showing = Data.TaggedEnum<{
  Current: {}
  Past: {}
  PastTranscript: { readonly conversation: PastConversation }
}>

const Showing = Data.taggedEnum<Showing>()

const showingCurrent = Showing.Current()

/** The Global conversation, floating over whichever area is open so that area stays in view. */
export function GlobalConversationDialog() {
  const [open, setOpen] = useAtom(globalConversationOpenAtom)
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
        <ConversationContext value={globalConversation}>
          <Shown showing={showing} show={setShowing} />
        </ConversationContext>
      </DialogContent>
    </Dialog>
  )
}

function Shown(props: { showing: Showing; show: (showing: Showing) => void }) {
  const { show } = props

  return Showing.$match(props.showing, {
    Current: () => <GlobalConversation onShowPast={() => show(Showing.Past())} />,
    Past: () => (
      <PastConversations
        onBack={() => show(showingCurrent)}
        onOpen={(conversation) => show(Showing.PastTranscript({ conversation }))}
      />
    ),
    PastTranscript: ({ conversation }) => (
      <PastTranscript conversation={conversation} onBack={() => show(Showing.Past())} />
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
        render={
          <Button variant="ghost" size="icon-sm" aria-label="Close the Global conversation" />
        }
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

function GlobalConversation(props: { onShowPast: () => void }) {
  const transcript = useAtomValue(globalConversation.transcript)
  const reconnect = useAtomRefresh(globalConversation.transcript)
  const choice = Option.getOrNull(AsyncResult.value(useAtomValue(globalModelAtom)))
  const changed = useAtomValue(changeGlobalModelAtom)
  const context = useAtomValue(capturedContextAtom)
  const markSeen = useAtomSet(markGlobalTurnSeenAtom)
  const focused = useWindowFocused()
  const unseen = Option.getOrNull(AsyncResult.value(useAtomValue(globalUnseenAtom)))
  const [started, startFresh] = useAtom(startGlobalFreshAtom)
  const [confirming, setConfirming] = useState(false)

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && unseen !== null && endedAt !== undefined) markSeen(endedAt)
  }, [markSeen, focused, unseen, endedAt])

  const startProblem = refusedFresh(started) ? null : settledProblem(started)

  return (
    <>
      <Header title="Global conversation">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Past conversations"
          onClick={props.onShowPast}
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
      <Transcript turns={turns} status={status} />
      <p className="truncate px-6 pb-1 text-xs text-muted-foreground">
        {context === null ? "No PR or Agent in view" : `Sends with ${contextLabel(context)}`}
      </p>
      <AgentComposer
        turns={turns}
        queued={queued}
        idlePlaceholder="Ask Glass about your work"
        problem={settledProblem(changed)}
        pickers={choice !== null && <GlobalModelPicker choice={choice} />}
      />
      <ConfirmationDialog
        open={confirming}
        title="Start fresh?"
        description="Your next message starts a new conversation. This one moves to Past conversations."
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

const spanOf = ({ startedAt, endedAt }: PastConversation) =>
  `${shortDate(startedAt)} – ${shortDate(endedAt)}`

function PastConversations(props: {
  onBack: () => void
  onOpen: (conversation: PastConversation) => void
}) {
  const past = useAtomValue(pastGlobalConversationsAtom)
  const problem = settledProblem(past)
  const conversations = Option.getOrElse(AsyncResult.value(past), () => [])

  return (
    <>
      <Header title="Past conversations" onBack={props.onBack} />
      <div className="flex-1 overflow-y-auto p-2">
        {problem !== null && <ProblemAlert problem={problem} />}
        {AsyncResult.isSuccess(past) && conversations.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Conversations you end with Start fresh appear here.
          </p>
        )}
        <ul>
          {conversations.map((conversation) => (
            <li key={conversation.id}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => props.onOpen(conversation)}
              >
                {spanOf(conversation)}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function PastTranscript(props: { conversation: PastConversation; onBack: () => void }) {
  const read = useAtomValue(pastGlobalTranscriptAtom(props.conversation.id))
  const problem = settledProblem(read)
  const { turns, status } = Option.getOrElse(AsyncResult.value(read), () => emptyTranscript)

  return (
    <>
      <Header title={spanOf(props.conversation)} onBack={props.onBack} />
      {problem !== null && <PaddedProblem problem={problem} />}
      <Transcript turns={turns} status={status} />
    </>
  )
}

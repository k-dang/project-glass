import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  emptyTranscript,
  isWaiting,
  localPlace,
  type ModelChoice,
  type PastChat,
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
import { placeKey } from "./conversationsArea"
import { ConversationComposer, contextLabel, Transcript } from "./ConversationView"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ConversationAtomsContext } from "./conversation"
import {
  capturedContextAtom,
  loadEarlierPastTurnsAtom,
  changeGlobalModelAtom,
  globalChat,
  globalChatOpenAtom,
  globalModelAtom,
  globalUnseenAtom,
  markGlobalTurnSeenAtom,
  pastChatsAtom,
  pastChatTranscriptAtom,
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
  Past: {}
  PastTranscript: { readonly chat: PastChat }
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
        <ConversationAtomsContext value={globalChat}>
          <Shown showing={showing} show={setShowing} />
        </ConversationAtomsContext>
      </DialogContent>
    </Dialog>
  )
}

function Shown(props: { showing: Showing; show: (showing: Showing) => void }) {
  const { show } = props

  return Showing.$match(props.showing, {
    Current: () => <GlobalChat onShowPast={() => show(Showing.Past())} />,
    Past: () => (
      <PastChats
        onBack={() => show(showingCurrent)}
        onOpen={(chat) => show(Showing.PastTranscript({ chat }))}
      />
    ),
    PastTranscript: ({ chat }) => (
      <PastTranscript chat={chat} onBack={() => show(Showing.Past())} />
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

function GlobalChat(props: { onShowPast: () => void }) {
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
        <Button variant="ghost" size="icon-sm" aria-label="Past chats" onClick={props.onShowPast}>
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
        {context === null ? "No PR or Conversation in view" : `Sends with ${contextLabel(context)}`}
      </p>
      <ConversationComposer
        turns={turns}
        queued={queued}
        idlePlaceholder="Ask Glass about your work"
        problem={settledProblem(changed)}
        pickers={choice !== null && <GlobalModelPicker choice={choice} />}
      />
      <ConfirmationDialog
        open={confirming}
        title="Start fresh?"
        description="Your next message starts a new chat. This one moves to Past chats."
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

const spanOf = ({ startedAt, endedAt }: PastChat) =>
  `${shortDate(startedAt)} – ${shortDate(endedAt)}`

function PastChats(props: { onBack: () => void; onOpen: (chat: PastChat) => void }) {
  const past = useAtomValue(pastChatsAtom)
  const problem = settledProblem(past)
  const chats = Option.getOrElse(AsyncResult.value(past), () => [])

  return (
    <>
      <Header title="Past chats" onBack={props.onBack} />
      <div className="flex-1 overflow-y-auto p-2">
        {problem !== null && <ProblemAlert problem={problem} />}
        {AsyncResult.isSuccess(past) && chats.length === 0 && (
          <p className="p-4 text-sm text-muted-foreground">
            Chats you end with Start fresh appear here.
          </p>
        )}
        <ul>
          {chats.map((chat) => (
            <li key={chat.id}>
              <Button
                variant="ghost"
                className="w-full justify-start"
                onClick={() => props.onOpen(chat)}
              >
                {spanOf(chat)}
              </Button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}

function PastTranscript(props: { chat: PastChat; onBack: () => void }) {
  const read = useAtomValue(pastChatTranscriptAtom(props.chat.id))
  const loadEarlier = useAtomSet(loadEarlierPastTurnsAtom(props.chat.id))

  const { turns, earlierTurns, status } = Option.getOrElse(
    AsyncResult.value(read),
    () => emptyTranscript,
  )

  return (
    <>
      <Header title={spanOf(props.chat)} onBack={props.onBack} />
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

import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { emptyTranscript, localPlace, type ModelChoice } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { X } from "lucide-react"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { placeKey } from "./agentsArea"
import { AgentComposer, contextLabel, Transcript } from "./AgentView"
import { ConversationContext } from "./conversation"
import {
  capturedContextAtom,
  changeGlobalModelAtom,
  globalConversation,
  globalConversationOpenAtom,
  globalModelAtom,
  globalUnseenAtom,
  markGlobalTurnSeenAtom,
} from "./globalConversation"
import { ModelPicker } from "./ModelPicker"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem, streamProblem } from "./problems"
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

/** The Global conversation, floating over whichever area is open so that area stays in view. */
export function GlobalConversationDialog() {
  const [open, setOpen] = useAtom(globalConversationOpenAtom)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="flex h-[min(48rem,calc(100vh-4rem))] flex-col gap-0 p-0 sm:max-w-2xl"
      >
        <GlobalConversation />
      </DialogContent>
    </Dialog>
  )
}

function GlobalConversation() {
  const transcript = useAtomValue(globalConversation.transcript)
  const reconnect = useAtomRefresh(globalConversation.transcript)
  const choice = Option.getOrNull(AsyncResult.value(useAtomValue(globalModelAtom)))
  const changed = useAtomValue(changeGlobalModelAtom)
  const context = useAtomValue(capturedContextAtom)
  const markSeen = useAtomSet(markGlobalTurnSeenAtom)
  const focused = useWindowFocused()
  const unseen = Option.getOrNull(AsyncResult.value(useAtomValue(globalUnseenAtom)))

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  const endedAt = turns.at(-1)?.ended?.at

  useEffect(() => {
    if (focused && unseen !== null && endedAt !== undefined) markSeen(endedAt)
  }, [markSeen, focused, unseen, endedAt])

  return (
    <ConversationContext value={globalConversation}>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
        <DialogTitle className="flex-1 truncate">Global conversation</DialogTitle>
        <DialogClose
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Close the Global conversation" />
          }
        >
          <X aria-hidden />
        </DialogClose>
      </header>
      {AsyncResult.isFailure(transcript) && !transcript.waiting && (
        <div className="px-4 pt-4">
          <ProblemAlert
            problem={streamProblem(transcript.cause)}
            action={{ label: "Reconnect", run: reconnect }}
          />
        </div>
      )}
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
    </ConversationContext>
  )
}

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { emptyTranscript, localPlace, type ModelChoice } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { placeKey } from "./agentsArea"
import { AgentComposer, contextLabel, Transcript } from "./AgentView"
import { ConversationContext } from "./conversation"
import {
  capturedContextAtom,
  changeGlobalModelAtom,
  globalConversation,
  globalConversationOpenAtom,
  globalModelAtom,
} from "./globalConversation"
import { ModelPicker } from "./ModelPicker"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem, streamProblem } from "./problems"

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

export function GlobalConversationPanel() {
  const setOpen = useAtomSet(globalConversationOpenAtom)
  const transcript = useAtomValue(globalConversation.transcript)
  const reconnect = useAtomRefresh(globalConversation.transcript)
  const choice = Option.getOrNull(AsyncResult.value(useAtomValue(globalModelAtom)))
  const changed = useAtomValue(changeGlobalModelAtom)
  const context = useAtomValue(capturedContextAtom)

  const { turns, queued, status } = Option.getOrElse(
    AsyncResult.value(transcript),
    () => emptyTranscript,
  )

  return (
    <ConversationContext value={globalConversation}>
      <aside
        aria-label="Global conversation"
        className="flex w-[28rem] shrink-0 flex-col border-l bg-background"
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <h2 className="flex-1 truncate font-medium">Global conversation</h2>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close the Global conversation"
            onClick={() => setOpen(false)}
          >
            <X aria-hidden />
          </Button>
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
      </aside>
    </ConversationContext>
  )
}

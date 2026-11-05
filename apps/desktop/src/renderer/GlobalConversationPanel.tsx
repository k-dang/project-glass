import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AgentEngine,
  emptyTranscript,
  type GlobalConversationProgram,
  thisMac,
} from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { placeKey } from "./agentsArea"
import { AgentComposer, Transcript } from "./AgentView"
import { ConversationContext } from "./conversation"
import {
  changeGlobalProgramAtom,
  globalConversation,
  globalConversationOpenAtom,
  globalProgramAtom,
} from "./globalConversation"
import { ModelPicker } from "./ModelPicker"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem, streamProblem } from "./problems"

function ProgramPicker(props: { program: GlobalConversationProgram }) {
  const { program } = props
  const change = useAtomSet(changeGlobalProgramAtom)

  return (
    <ModelPicker
      engine={program.engine}
      placeKey={placeKey(thisMac)}
      model={program.model}
      effort={program.effort}
      onChange={(choice) => change({ engine: program.engine, ...choice })}
      programs={{
        engines: AgentEngine.literals,
        onChange: (engine) => change({ engine, model: null, effort: null }),
      }}
    />
  )
}

/** The Global conversation beside whichever area the user is in, leaving that area as it was. */
export function GlobalConversationPanel() {
  const setOpen = useAtomSet(globalConversationOpenAtom)
  const transcript = useAtomValue(globalConversation.transcript)
  const reconnect = useAtomRefresh(globalConversation.transcript)
  const program = Option.getOrNull(AsyncResult.value(useAtomValue(globalProgramAtom)))
  const changed = useAtomValue(changeGlobalProgramAtom)

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
        <AgentComposer
          turns={turns}
          queued={queued}
          idlePlaceholder="Ask Glass about your work"
          problem={settledProblem(changed)}
          pickers={program !== null && <ProgramPicker program={program} />}
        />
      </aside>
    </ConversationContext>
  )
}

import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { Agent, ChangedFile, Turn } from "@glass/contracts"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { FileDiff, PanelLeft } from "lucide-react"
import { useCallback, useId, useMemo, useRef, useState } from "react"
import { flushSync } from "react-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { agentChangesAtom } from "./agentsArea"
import { ChangedFilesTree } from "./ChangedFilesTree"
import {
  type Display,
  defaultDisplay,
  ReadOnlyDiffView,
  useOpenedFiles,
  type ViewHandle,
} from "./ChangedFilesView"
import { ChangesToolbar } from "./ChangesToolbar"
import { type CollapseChoices, layOut } from "./changesView"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"

const ignorePath = (_path: string) => undefined

export function AgentChanges(props: { agent: Agent; turns: ReadonlyArray<Turn> }) {
  const { agent } = props
  const changes = useAtomValue(agentChangesAtom(agent.id))
  const refresh = useAtomRefresh(agentChangesAtom(agent.id))
  const turnsEnded = props.turns.filter((turn) => turn.ended !== null).length
  const [turnsEndedAtSnapshot, setTurnsEndedAtSnapshot] = useState(turnsEnded)

  const showLatest = () => {
    setTurnsEndedAtSnapshot(turnsEnded)
    refresh()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <p className="border-b px-6 py-2.5 text-sm text-muted-foreground">
        Changes since {agent.baseBranch}, including uncommitted work
      </p>
      {turnsEnded > turnsEndedAtSnapshot && (
        <div className="border-b px-6 py-3">
          <Alert role="note">
            <FileDiff aria-hidden />
            <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48">
                The Agent has worked since you opened these changes.
              </span>
              <Button variant="outline" size="sm" onClick={showLatest}>
                Show latest
              </Button>
            </AlertDescription>
          </Alert>
        </div>
      )}
      {AsyncResult.isFailure(changes) && !changes.waiting && (
        <div className="px-6 pt-4">
          <ProblemAlert
            problem={problemOf(changes.cause)}
            action={{ label: "Retry", run: refresh }}
          />
        </div>
      )}
      {AsyncResult.isSuccess(changes) && !changes.waiting && (
        <Changes key={turnsEndedAtSnapshot} files={changes.value} />
      )}
    </div>
  )
}

function Changes(props: { files: ReadonlyArray<ChangedFile> }) {
  const { files } = props
  const layout = useMemo(() => layOut(files), [files])
  const [filePanelOpen, setFilePanelOpen] = useState(true)
  const filePanelId = useId()
  const [display, setDisplay] = useState<Display>(defaultDisplay)
  const [all, setAll] = useState<CollapseChoices["all"]>("expanded")
  const view = useRef<ViewHandle>(null)
  const viewOf = useCallback(() => view.current, [])
  const { opened, setOpened, setFilesOpen } = useOpenedFiles(viewOf)

  const setFileOpen = useCallback(
    (path: string, open: boolean) => setFilesOpen([path], open),
    [setFilesOpen],
  )

  const showFile = (path: string, behavior: "instant" | "smooth") => {
    flushSync(() =>
      setOpened((previous) =>
        previous.get(path) === true ? previous : new Map(previous).set(path, true),
      ),
    )
    view.current?.scrollTo({ type: "item", id: path, align: "start", behavior })
  }

  const showAll = (next: CollapseChoices["all"]) => {
    flushSync(() => {
      setAll(next)
      setOpened(new Map())
    })
  }

  const filePanelLabel = filePanelOpen ? "Hide file panel" : "Show file panel"

  return (
    <div className="flex min-h-0 flex-1">
      <aside
        id={filePanelId}
        aria-label="Changed files"
        className={cn("flex w-80 shrink-0 flex-col border-r", !filePanelOpen && "hidden")}
      >
        {layout.files.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">No files changed.</p>
        ) : (
          <ChangedFilesTree layout={layout} onSelect={showFile} viewedFiles={null} />
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <ChangesToolbar
          filePanelToggle={
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={filePanelLabel}
              aria-expanded={filePanelOpen}
              aria-controls={filePanelId}
              title={filePanelLabel}
              onClick={() => setFilePanelOpen((open) => !open)}
            >
              <PanelLeft aria-hidden />
            </Button>
          }
          fileCount={layout.files.length}
          viewedCount={null}
          display={display}
          onDisplayChange={setDisplay}
          all={all}
          onAllChange={showAll}
          tourOrder={null}
          agentReview={null}
        />
        {layout.files.length > 0 && (
          <ReadOnlyDiffView
            initialPath={null}
            ref={view}
            files={layout.files}
            display={display}
            opened={opened}
            all={all}
            onOpenChange={setFileOpen}
            onCurrentPathChange={ignorePath}
          />
        )}
      </div>
    </div>
  )
}

import type { ChangedFile } from "@glass/contracts"
import type { AnnotationSide } from "@pierre/diffs"
import { cn } from "cn"
import { AsyncResult } from "effect/reactivity"
import { FolderTree, History, MessageSquareText, PanelLeft } from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import type { BackendError } from "./backend"
import { ChangedFilesTree } from "./ChangedFilesTree"
import {
  type Display,
  defaultDisplay,
  DiffView,
  useOpenedFiles,
  type ViewHandle,
} from "./ChangedFilesView"
import { type CollapseChoices, layOut, noneCollapsedWhenSuggested } from "./changesView"
import { ChangesToolbar } from "./ChangesToolbar"
import { type FeedbackAnnotation, isOlder } from "./feedbackLines"
import { FilePanelTabsList, FilePanelTabTrigger } from "./FilePanelTabs"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { useFeedbackComposer } from "./useFeedbackComposer"
import type { FeedbackNotesEditor } from "./useFeedbackNotes"

export type SidebarTab = "files" | "feedback"

const NoteOpenContext = createContext(false)

export const useNoteOpen = () => useContext(NoteOpenContext)

export function ChangesWithFeedback(props: {
  changes:
    | { readonly id: string; readonly files: ReadonlyArray<ChangedFile> }
    | "loading"
    | "unavailable"
  store: FeedbackNotesEditor
  sidebarTab: SidebarTab
  setSidebarTab: (tab: SidebarTab) => void
  footer: ReactNode
}) {
  const { changes, store, sidebarTab, setSidebarTab } = props
  const read = changes === "loading" || changes === "unavailable" ? null : changes
  const changesId = read?.id ?? null
  const layout = useMemo(() => layOut(read?.files ?? []), [read])

  const [filePanelOpen, setFilePanelOpen] = useState(true)
  const filePanelId = useId()
  const [display, setDisplay] = useState<Display>(defaultDisplay)
  const [all, setAll] = useState<CollapseChoices["all"]>("expanded")
  const view = useRef<ViewHandle<FeedbackAnnotation>>(null)
  const viewOf = useCallback(() => view.current, [])
  const { opened, setOpened, setFilesOpen } = useOpenedFiles(viewOf)
  const older = store.notes.filter((note) => isOlder(note, changesId)).length

  const setFileOpen = useCallback(
    (path: string, open: boolean) => setFilesOpen([path], open),
    [setFilesOpen],
  )

  const openFile = (path: string) => setFilesOpen([path], true)

  const showFile = (path: string, behavior: "instant" | "smooth") => {
    openFile(path)
    view.current?.scrollTo({ type: "item", id: path, align: "start", behavior })
  }

  const reveal = (
    path: string,
    lineNumber: number,
    side: AnnotationSide,
    align: "center" | "nearest",
  ) => {
    openFile(path)
    view.current?.scrollTo({ type: "line", id: path, lineNumber, side, align })
  }

  const diffArea = useRef<HTMLDivElement>(null)

  const feedback = useFeedbackComposer({
    changesId,
    store,
    layout,
    reveal,
    diffArea,
  })

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
        <Tabs value={sidebarTab} onValueChange={setSidebarTab} className="min-h-0 flex-1 gap-0">
          <FilePanelTabsList>
            <FilePanelTabTrigger value="files" icon={FolderTree}>
              Files
            </FilePanelTabTrigger>
            <FilePanelTabTrigger value="feedback" icon={MessageSquareText}>
              Feedback
              {store.notes.length > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {store.notes.length}
                </span>
              )}
            </FilePanelTabTrigger>
          </FilePanelTabsList>
          <TabsContent value="files" keepMounted className="flex min-h-0 flex-col">
            {changes === "loading" ? null : layout.files.length === 0 ? (
              <p className="px-4 py-6 text-sm text-muted-foreground">
                {changes === "unavailable"
                  ? "Glass couldn't read these changes."
                  : "No files changed."}
              </p>
            ) : (
              <ChangedFilesTree layout={layout} onSelect={showFile} viewedFiles={null} />
            )}
          </TabsContent>
          <TabsContent value="feedback" className="flex min-h-0 flex-col">
            {feedback.overview}
          </TabsContent>
        </Tabs>
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
          fileCount={changes === "loading" ? "loading" : layout.files.length}
          viewedCount={null}
          display={display}
          onDisplayChange={setDisplay}
          all={all}
          onAllChange={showAll}
          tourOrder={null}
          fullScreen={null}
          agentWork={null}
        />
        <NoteOpenContext value={feedback.editing}>{props.footer}</NoteOpenContext>
        {older > 0 && (
          <OlderNotes
            count={older}
            onView={() => {
              setFilePanelOpen(true)
              setSidebarTab("feedback")
            }}
          />
        )}
        {layout.files.length > 0 && (
          <div ref={diffArea} className="flex min-h-0 flex-1 flex-col">
            <DiffView
              initialPath={null}
              ref={view}
              files={layout.files}
              summaries={null}
              renderGutterUtility={null}
              display={display}
              opened={opened}
              all={all}
              collapsedWhenSuggested={noneCollapsedWhenSuggested}
              onOpenChange={setFileOpen}
              {...feedback.diffProps}
            />
          </div>
        )}
      </div>
    </div>
  )
}

export function LoadProblem(props: {
  result: AsyncResult.AsyncResult<unknown, BackendError>
  retry: () => void
}) {
  const { result } = props

  return AsyncResult.isFailure(result) && !result.waiting ? (
    <div className="px-6 pt-4">
      <ProblemAlert
        problem={problemOf(result.cause)}
        action={{ label: "Retry", run: props.retry }}
      />
    </div>
  ) : null
}

function OlderNotes(props: { count: number; onView: () => void }) {
  return (
    <div className="border-t px-4 py-2">
      <Alert role="note">
        <History aria-hidden />
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-48">
            {plural(props.count, "Feedback note")} {props.count === 1 ? "is" : "are"} on an older
            version of these changes, with the code you read kept.
          </span>
          <Button variant="outline" size="sm" onClick={props.onView}>
            View feedback
          </Button>
        </AlertDescription>
      </Alert>
    </div>
  )
}

import { RegistryContext, useAtom } from "@effect/atom-react"
import type {
  DiffSide,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  PullRequestWorkspace,
  Revision,
  TourCodeTarget,
} from "@glass/contracts"
import { referenceKey } from "@glass/contracts"
import { cn } from "cn"
import {
  ChevronRight,
  FileDiff,
  FolderTree,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
  MessageCircle,
  PanelLeft,
  RotateCw,
  Route,
} from "lucide-react"
import {
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react"
import { flushSync } from "react-dom"
import { TooltipHint } from "@/components/ui/tooltip"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { FilePanelTabsList, FilePanelTabTrigger } from "./FilePanelTabs"
import type { ActivityRecorder } from "./activity"
import { AgentWork } from "./AgentWork"
import { AgentReviewCard } from "./AgentReviewCard"
import { AgentReviewPanel, AgentReviewSidePanel } from "./AgentReviewPanel"
import { BackToPullRequests } from "./BackToPullRequests"
import { annotationSides, type CollapseChoices, layOut, type ShowNote } from "./changesView"
import { ChangedFilesTree } from "./ChangedFilesTree"
import {
  ChangedFilesView,
  type Display,
  defaultDisplay,
  useOpenedFiles,
  type ViewHandle,
} from "./ChangedFilesView"
import { ChangesToolbar } from "./ChangesToolbar"
import { CopyMenu } from "./CopyMenu"
import { OutdatedDiscussions, Timeline } from "./Discussions"
import { GitHubHtml } from "./GitHubHtml"
import { DraftList, showDraft } from "./Drafts"
import { NotesList } from "./Notes"
import { ProblemAlert } from "./ProblemAlert"
import type { Problem } from "./problems"
import { RepositoryBrowser } from "./RepositoryBrowser"
import { FinishReview } from "./FinishReview"
import { OpenPullRequestDialog } from "./OpenPullRequestDialog"
import { closedAs, StatusChips } from "./PullRequestStatus"
import {
  type ChangesOrder,
  readAgentReviewOnOpenAtom,
  type WorkspaceTab,
  workspaceViewAtom,
} from "./reviewsArea"
import { ShortSha } from "./shortSha"
import type { HotspotFocus } from "./Hotspots"
import type { AskStore } from "./useAsks"
import { type DraftStore, useDraftCount, useDraftsLocked } from "./useDrafts"
import { useFullFiles } from "./useFullFiles"
import type { ReplyStore } from "./useReplies"
import type { Reactions } from "./useReactions"
import type { Resolutions } from "./useResolutions"
import { type ViewedFilesStore, useViewedFiles } from "./useViewedFiles"
import { useShortcuts } from "./useShortcuts"
import { TourView, type TourViewHandle } from "./TourView"
import { hasOverview, readTour } from "./tourReading"
import { useTour } from "./useTour"
import { useAgentReview } from "./useAgentReview"
import { positionOf } from "./reviewPosition"
import { rememberPlace } from "./savedPlace"
import { TourSidebar, useTourReadyToast } from "./TourSidebar"

const wideWorkspaceQuery = "(min-width: 1024px)"

type FilePanelTab = "tree" | "notes" | "tour"

export function Workspace(props: {
  workspace: PullRequestWorkspace
  activity: ActivityRecorder
  drafts: DraftStore
  asks: AskStore
  replies: ReplyStore
  resolutions: Resolutions
  reactions: Reactions
  viewedFiles: ViewedFilesStore
  reloading: boolean
  changedOnGitHub: boolean
  onReload: () => void
  onBack: () => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const { pullRequest, revision, files, discussions } = props.workspace
  const tour = useTour(pullRequest.ref, revision)
  const agentReview = useAgentReview(pullRequest.ref, revision, closedAs(pullRequest))
  const currentReview = agentReview.current

  const lowAttention = useMemo(
    () => new Set(currentReview?.lowAttention.map(({ path }) => path)),
    [currentReview],
  )

  const registry = useContext(RegistryContext)
  const [workspaceView, setView] = useAtom(workspaceViewAtom)
  const { tab, file: currentPath, order: chosenOrder, repositoryFile } = workspaceView

  useEffect(() => {
    rememberPlace(registry, {
      area: "reviews",
      login: props.workspace.viewer.login,
      pullRequest: pullRequest.ref,
      revision,
      position: positionOf(workspaceView),
    })
  }, [registry, props.workspace.viewer.login, pullRequest.ref, revision, workspaceView])

  const [filePanelOpen, setFilePanelOpen] = useState(
    () => window.matchMedia(wideWorkspaceQuery).matches,
  )

  const filePanelId = useId()
  const [display, setDisplay] = useState<Display>(defaultDisplay)
  const [all, setAll] = useState<CollapseChoices["all"]>("suggested")
  const [hotspotFocus, setHotspotFocus] = useState<HotspotFocus | null>(null)
  const view = useRef<ViewHandle>(null)
  const tourView = useRef<TourViewHandle>(null)
  const [panelTab, setPanelTab] = useState<FilePanelTab>("tree")
  const [pendingReview, setPendingReview] = useAtom(readAgentReviewOnOpenAtom)
  const opensReview = pendingReview === referenceKey(pullRequest.ref)
  const [reviewOpen, setReviewOpen] = useState(opensReview)

  if (opensReview) {
    setPendingReview(null)

    if (!reviewOpen) setReviewOpen(true)

    setView((previous) => (previous.tab === "changes" ? previous : { ...previous, tab: "changes" }))
  }

  const fullFiles = useFullFiles(pullRequest.ref, revision)
  const { activity, drafts, asks, replies, resolutions, reactions } = props
  const draftCount = useDraftCount(drafts)
  const draftsLocked = useDraftsLocked(drafts)
  const viewed = useViewedFiles(props.viewedFiles)
  const [browsed, setBrowsed] = useState(tab === "files")

  useEffect(() => {
    const width = window.matchMedia(wideWorkspaceQuery)
    const followWidth = () => setFilePanelOpen(width.matches)

    width.addEventListener("change", followWidth)

    return () => width.removeEventListener("change", followWidth)
  }, [])

  const layout = useMemo(() => layOut(files), [files])
  const { saved } = tour

  const reading = useMemo(
    () => (saved === null ? null : readTour(layout.files, saved, revision, currentReview)),
    [layout, saved, revision, currentReview],
  )

  const tourShown = chosenOrder === "tour" ? reading : null
  const shown = tourShown?.files ?? layout.files

  const inChanges = tab === "changes"
  const tourInChanges = inChanges && tourShown !== null

  const [fullScreenChosen, setFullScreen] = useState(false)
  const fullScreen = fullScreenChosen && inChanges

  const current = shown.find((entry) => entry.file.path === currentPath)?.file ?? shown[0]?.file

  const viewingPath = inChanges ? (current?.path ?? null) : null

  useEffect(
    () => (viewingPath === null ? undefined : activity.view(viewingPath)),
    [activity, viewingPath],
  )

  const setCurrentPath = useCallback(
    (file: string) =>
      setView((previous) => (previous.file === file ? previous : { ...previous, file })),
    [setView],
  )

  const revisionKey = `${pullRequest.id}:${revision.base}...${revision.head}`

  const viewOf = useCallback(
    (path: string) => (tourView.current === null ? view.current : tourView.current.viewOf(path)),
    [],
  )

  const { opened, setOpened, setFilesOpen } = useOpenedFiles(viewOf)

  const setFileOpen = useCallback(
    (path: string, open: boolean) => setFilesOpen([path], open),
    [setFilesOpen],
  )

  const setViewed = useCallback(
    (paths: ReadonlyArray<string>, checked: boolean) => {
      if (props.viewedFiles.snapshot().locked) return

      for (const path of paths) props.viewedFiles.set(path, checked)

      setFilesOpen(paths, !checked)
    },
    [props.viewedFiles, setFilesOpen],
  )

  const viewedInTree = useMemo(
    () => ({ store: props.viewedFiles, onChange: setViewed }),
    [props.viewedFiles, setViewed],
  )

  const returnToCurrent = (inTour: boolean) => {
    if (current === undefined) return

    if (inTour) tourView.current?.returnTo(current.path)
    else view.current?.scrollTo({ type: "item", id: current.path, align: "start" })
  }

  const showOrder = (next: ChangesOrder) => {
    flushSync(() => setView((previous) => ({ ...previous, order: next })))
    returnToCurrent(next === "tour" && reading !== null)
  }

  const openChapter = (index: number, behavior: "smooth" | "instant" = "smooth") => {
    const chapter = reading?.chapters[index]

    if (chapter === undefined) return
    flushSync(() =>
      setView((previous) => ({
        ...previous,
        tab: "changes",
        order: "tour",
        file: chapter.paths[0] ?? previous.file,
      })),
    )
    tourView.current?.showChapter(index, behavior)
  }

  const startReading = () => {
    openChapter(0)

    if (reading !== null && hasOverview(reading)) tourView.current?.showOverview()
  }

  useShortcuts([
    ...(inChanges ? [{ key: "f", run: () => setFullScreen(!fullScreen) }] : []),
    ...(fullScreen ? [{ key: "Escape", run: () => setFullScreen(false) }] : []),
    ...(tourInChanges
      ? [
          {
            key: "]",
            run: () => openChapter((tourView.current?.currentChapter() ?? 0) + 1, "instant"),
          },
          {
            key: "[",
            run: () => {
              const inView = tourView.current?.currentChapter() ?? 0

              if (inView === 0 && reading !== null && hasOverview(reading))
                tourView.current?.showOverview()
              else openChapter(inView - 1, "instant")
            },
          },
        ]
      : []),
  ])

  useTourReadyToast(tour.latest, reading, startReading)

  const openInChanges = (path: string, order: ChangesOrder = chosenOrder) =>
    flushSync(() => {
      setView((previous) => ({ ...previous, tab: "changes", order, file: path }))
      setOpened((paths) => (paths.get(path) === true ? paths : new Map(paths).set(path, true)))
    })

  const showFile = (path: string, behavior: "instant" | "smooth" = "smooth") => {
    openInChanges(path)

    if (tourShown !== null) tourView.current?.showFile(path, behavior)
    else view.current?.scrollTo({ type: "item", id: path, align: "start", behavior })
  }

  const showPlace = (place: TourCodeTarget, order: ChangesOrder = chosenOrder) => {
    openInChanges(place.path, order)

    if (order === "tour" && reading !== null) {
      tourView.current?.showRange(place)

      return
    }

    const side = annotationSides[place.side]

    view.current?.setSelectedLines({
      id: place.path,
      range: { start: place.startLine, end: place.endLine, side },
    })
    view.current?.scrollTo({
      type: "line",
      id: place.path,
      lineNumber: place.startLine,
      side,
      align: "center",
      behavior: "smooth-auto",
    })
  }

  const showLine = (path: string, side: DiffSide, line: number) =>
    showPlace({ path, side, startLine: line, endLine: line })

  const show: ShowNote = { file: showFile, line: showLine }

  const showInReview = (rank: number) => {
    setHotspotFocus({ rank })
    readAgentReview()
  }

  const showAll = (next: CollapseChoices["all"]) => {
    flushSync(() => {
      setAll(next)
      setOpened(new Map())
    })

    if (next === "collapsed") returnToCurrent(tourShown !== null)
  }

  const showTab = (next: WorkspaceTab) => {
    flushSync(() => {
      setView((previous) => ({ ...previous, tab: next }))

      if (next === "files") setBrowsed(true)
    })

    if (next === "changes") returnToCurrent(tourShown !== null)
  }

  const readAgentReview = () => {
    flushSync(() => {
      setReviewOpen(true)
      setView((previous) => ({ ...previous, tab: "changes" }))
    })

    returnToCurrent(tourShown !== null)
  }

  const reviewShown = inChanges && reviewOpen
  const layoutKnown = tour.known && agentReview.known

  const agentWork = (
    <AgentWork
      tour={tour}
      reading={reading}
      review={agentReview}
      onReadTour={startReading}
      onReadReview={readAgentReview}
    />
  )

  useShortcuts(
    agentReview.review === null
      ? []
      : [
          {
            key: "d",
            mod: true,
            allowInEditable: true,
            run: () => (reviewShown ? setReviewOpen(false) : readAgentReview()),
          },
        ],
  )

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const filePanelLabel = filePanelOpen ? "Hide file panel" : "Show file panel"
  const noteCount = discussions.onLines.length + draftCount

  const filePanelToggle = (
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
  )

  return (
    <Tabs
      value={tab}
      onValueChange={showTab}
      className={cn("min-h-0 flex-1 gap-0", fullScreen && "fixed inset-0 z-40 bg-background")}
    >
      <CopyMenu pullRequest={pullRequest} />
      {fullScreen ? (
        <div className="title-strip shrink-0 border-b" aria-hidden />
      ) : (
        <PullRequestHeader
          pullRequest={pullRequest}
          revision={revision}
          reloading={props.reloading}
          changedOnGitHub={props.changedOnGitHub}
          busy={draftsLocked}
          onReload={props.onReload}
          onBack={props.onBack}
          open={
            <>
              {agentWork}
              <OpenPullRequestDialog current={pullRequest.ref} onOpen={props.onOpen} />
            </>
          }
          review={
            <FinishReview
              key={pullRequest.id}
              store={drafts}
              viewerIsAuthor={pullRequest.viewerIsAuthor}
              onReload={props.onReload}
            />
          }
          tabs={
            <TabsList
              variant="line"
              aria-label="PR workspace"
              className="shrink-0 justify-start gap-2 p-0 group-data-horizontal/tabs:h-9"
            >
              <WorkspaceTabTrigger value="overview" label="Overview" />
              <WorkspaceTabTrigger value="changes" label="Changes" />
              <WorkspaceTabTrigger value="files" label="Repository" />
            </TabsList>
          }
        />
      )}
      <ProblemBanner problem={fullFiles.problem} />
      <ViewedFilesProblem store={props.viewedFiles} onReload={props.onReload} />
      {layoutKnown && (
        <div className="flex min-h-0 flex-1">
          <aside
            id={filePanelId}
            className={cn(
              "flex w-80 shrink-0 flex-col border-r",
              (!filePanelOpen || tab === "files" || tourInChanges) && "hidden",
            )}
          >
            <Tabs value={panelTab} onValueChange={setPanelTab} className="min-h-0 flex-1 gap-0">
              <FilePanelTabsList>
                <FilePanelTabTrigger value="tree" icon={FolderTree}>
                  Tree
                </FilePanelTabTrigger>
                <FilePanelTabTrigger value="notes" icon={MessageCircle}>
                  Notes
                  {noteCount > 0 && (
                    <span className="text-xs text-muted-foreground tabular-nums">{noteCount}</span>
                  )}
                </FilePanelTabTrigger>
                <FilePanelTabTrigger value="tour" icon={Route}>
                  Tour
                </FilePanelTabTrigger>
              </FilePanelTabsList>
              <TabsContent value="tree" keepMounted className="flex min-h-0 flex-col">
                {files.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-muted-foreground">No files changed.</p>
                ) : (
                  <ChangedFilesTree
                    key={revisionKey}
                    layout={layout}
                    onSelect={showFile}
                    viewedFiles={viewedInTree}
                  />
                )}
              </TabsContent>
              <TabsContent value="notes" className="flex min-h-0 flex-col">
                <NotesList
                  paths={layout.tree.paths}
                  discussions={discussions.onLines}
                  drafts={drafts}
                  show={show}
                />
              </TabsContent>
              <TabsContent value="tour" className="flex min-h-0 flex-col">
                <TourSidebar
                  tour={tour}
                  reading={reading}
                  viewedFiles={props.viewedFiles}
                  onShowChapter={openChapter}
                  onStartReading={startReading}
                />
              </TabsContent>
            </Tabs>
            <details open className="group/stats mx-3 shrink-0 border-t pb-2">
              <summary className="flex cursor-pointer list-none items-center gap-2 py-3 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight aria-hidden className="size-3 group-open/stats:rotate-90" />
                <FileDiff aria-hidden className="size-3.5" />
                Diff stats
              </summary>
              <table className="w-full text-xs" aria-label="Diff stats for this Revision">
                <tbody>
                  <tr className="border-t">
                    <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                      Files
                    </th>
                    <td className="text-right font-mono tabular-nums">
                      {files.length.toLocaleString()}
                    </td>
                  </tr>
                  <tr className="border-t">
                    <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                      Additions
                    </th>
                    <td className="text-right font-mono text-added tabular-nums">
                      {additions.toLocaleString()}
                    </td>
                  </tr>
                  <tr className="border-t">
                    <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                      Deletions
                    </th>
                    <td className="text-right font-mono text-deleted tabular-nums">
                      {deletions.toLocaleString()}
                    </td>
                  </tr>
                </tbody>
              </table>
            </details>
          </aside>
          <TabsContent value="overview" keepMounted className="flex min-h-0 min-w-0 flex-col">
            <div className="flex items-center gap-1 px-6 py-2 text-sm text-muted-foreground">
              {filePanelToggle}
              <span>PR overview</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
              <div className="flex flex-col gap-8 px-6 py-8">
                <AgentReviewCard
                  controls={agentReview}
                  onRead={readAgentReview}
                  onReadHotspot={showInReview}
                />
                <Description html={pullRequest.descriptionHtml} />
                <DraftList store={drafts} onShow={(draft) => showDraft(show, draft)} />
                <Timeline items={discussions.timeline} reactions={reactions} />
                <OutdatedDiscussions
                  discussions={discussions.outdated}
                  replies={replies}
                  resolutions={resolutions}
                  reactions={reactions}
                />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="changes" className="flex min-w-0 flex-col">
            <ChangesToolbar
              filePanelToggle={tourInChanges ? null : filePanelToggle}
              fileCount={files.length}
              viewedCount={viewed.viewed.size}
              display={display}
              onDisplayChange={setDisplay}
              all={all}
              onAllChange={showAll}
              tourOrder={reading === null ? null : { current: chosenOrder, onChange: showOrder }}
              fullScreen={{ on: fullScreen, onChange: setFullScreen }}
              agentWork={fullScreen && agentWork}
            />
            {tourShown !== null ? (
              <TourView
                key={revisionKey}
                initialPath={currentPath}
                ref={tourView}
                reading={tourShown}
                onShowInReview={showInReview}
                lowAttention={lowAttention}
                discussions={discussions.onLines}
                drafts={drafts}
                asks={asks}
                replies={replies}
                resolutions={resolutions}
                reactions={reactions}
                onReload={props.onReload}
                viewedFiles={props.viewedFiles}
                onViewedChange={setViewed}
                display={display}
                loadDiffFiles={fullFiles.loadDiffFiles}
                opened={opened}
                all={all}
                onOpenChange={setFileOpen}
                onCurrentPathChange={setCurrentPath}
              />
            ) : (
              files.length > 0 && (
                <ChangedFilesView
                  key={revisionKey}
                  initialPath={currentPath}
                  ref={view}
                  files={shown}
                  discussions={discussions.onLines}
                  drafts={drafts}
                  asks={asks}
                  replies={replies}
                  resolutions={resolutions}
                  reactions={reactions}
                  onReload={props.onReload}
                  viewedFiles={props.viewedFiles}
                  onViewedChange={setViewed}
                  display={display}
                  loadDiffFiles={fullFiles.loadDiffFiles}
                  opened={opened}
                  all={all}
                  onOpenChange={setFileOpen}
                  onCurrentPathChange={setCurrentPath}
                  summaries={null}
                  lowAttention={lowAttention}
                />
              )
            )}
          </TabsContent>
          {reviewShown && agentReview.review !== null && (
            <AgentReviewSidePanel onClose={() => setReviewOpen(false)}>
              <AgentReviewPanel
                review={agentReview.review}
                controls={agentReview}
                drafts={drafts}
                show={show}
                hotspotLinks={{
                  onShowPlace: (place) => showPlace(place),
                  chapterOf: (rank) =>
                    reading?.hotspots?.find((entry) => entry.rank === rank)?.chapter ?? null,
                  onShowInTour: (place) => showPlace(place, "tour"),
                  focus: hotspotFocus,
                }}
              />
            </AgentReviewSidePanel>
          )}
          <TabsContent value="files" keepMounted className="flex min-w-0">
            {browsed && (
              <RepositoryBrowser
                key={revisionKey}
                pullRequest={pullRequest.ref}
                revision={revision}
                changedFiles={files}
                path={repositoryFile}
                onSelect={(path) => setView((previous) => ({ ...previous, repositoryFile: path }))}
              />
            )}
          </TabsContent>
        </div>
      )}
    </Tabs>
  )
}

function WorkspaceTabTrigger(props: { value: WorkspaceTab; label: string }) {
  return (
    <TabsTrigger
      value={props.value}
      className="h-full flex-none rounded-none px-2 transition-none after:transition-none group-data-horizontal/tabs:after:-bottom-px"
    >
      {props.label}
    </TabsTrigger>
  )
}

function ProblemBanner(props: { problem: Problem | null }) {
  if (props.problem === null) return null

  return (
    <div className="border-b px-6 py-3">
      <ProblemAlert problem={props.problem} />
    </div>
  )
}

function ViewedFilesProblem(props: { store: ViewedFilesStore; onReload: () => void }) {
  const { failures, locked } = useViewedFiles(props.store)
  const first = failures.entries().next().value

  if (first === undefined) return null

  const [path, { problem }] = first

  return (
    <div className="border-b px-6 py-3">
      <p className="mb-2 text-sm">Couldn't save Viewed for {path}.</p>
      <ProblemAlert
        problem={problem}
        action={
          locked
            ? undefined
            : problem.fixedByReload
              ? { label: "Reload", run: props.onReload }
              : { label: "Try again", run: () => props.store.retry(path) }
        }
      />
    </div>
  )
}

function PullRequestHeader(props: {
  pullRequest: PullRequest
  revision: Revision
  reloading: boolean
  changedOnGitHub: boolean
  busy: boolean
  onReload: () => void
  onBack: () => void
  open: ReactNode
  review: ReactNode
  tabs: ReactNode
}) {
  const { pullRequest, revision } = props
  const { owner, repo, number } = pullRequest.ref

  return (
    <header className="flex flex-col border-b px-4">
      <div className="flex h-11 items-center gap-2">
        <BackToPullRequests onBack={props.onBack} disabled={props.busy} iconOnly />
        <StateIcon pullRequest={pullRequest} />
        <h1 className="min-w-0 truncate text-base font-semibold tracking-tight">
          {pullRequest.title} <span className="font-normal text-muted-foreground">#{number}</span>
        </h1>
        <span className="hidden min-w-0 shrink-[2] truncate text-sm text-muted-foreground xl:inline">
          {owner}/{repo} by{" "}
          <span className="font-medium text-foreground">{pullRequest.author}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-sm text-muted-foreground">
          {props.open}
          <TooltipHint
            content={
              props.changedOnGitHub
                ? "Changed on GitHub since Glass loaded it. Reload to see it as it is now."
                : "Reopen at the pull request's current revision"
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              onClick={props.onReload}
              disabled={props.busy}
              className={cn(
                props.changedOnGitHub &&
                  "bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200",
              )}
            >
              <RotateCw className={props.reloading ? "animate-spin" : undefined} aria-hidden />
            </Button>
          </TooltipHint>
          {props.review}
        </div>
      </div>
      <div className="flex min-w-0 items-center gap-4">
        {props.tabs}
        <div className="ml-auto flex min-w-0 items-center gap-2 overflow-hidden text-sm text-muted-foreground">
          <span className="hidden min-w-0 items-center gap-1 lg:flex">
            <Branch name={pullRequest.baseBranch} />
            <span aria-label="from">←</span>
            <Branch name={pullRequest.headBranch} />
            <span className="ml-1 shrink-0">
              Head <ShortSha sha={revision.head} />
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1">
            <StatusChips pullRequest={pullRequest} />
          </span>
        </div>
      </div>
    </header>
  )
}

const states: Record<
  PullRequestState,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  open: { label: "Open", icon: GitPullRequest, className: "bg-emerald-600 text-white" },
  draft: { label: "Draft", icon: GitPullRequestDraft, className: "bg-zinc-500 text-white" },
  closed: { label: "Closed", icon: GitPullRequestClosed, className: "bg-red-600 text-white" },
  merged: { label: "Merged", icon: GitMerge, className: "bg-violet-600 text-white" },
}

function StateIcon(props: { pullRequest: PullRequest }) {
  const { label, icon: Icon, className } = states[props.pullRequest.state]

  return (
    <TooltipHint content={label}>
      <span
        className={cn("flex size-5 shrink-0 items-center justify-center rounded-full", className)}
      >
        <Icon aria-label={label} className="size-3" />
      </span>
    </TooltipHint>
  )
}

function Branch(props: { name: string }) {
  return (
    <code className="min-w-0 truncate rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
      {props.name}
    </code>
  )
}

function Description(props: { html: string }) {
  return (
    <Card render={<section />}>
      <CardContent>
        {props.html.trim() === "" ? (
          <p className="text-sm text-muted-foreground italic">No description provided.</p>
        ) : (
          <GitHubHtml html={props.html} />
        )}
      </CardContent>
    </Card>
  )
}

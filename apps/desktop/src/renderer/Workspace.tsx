import { RegistryContext, useAtom } from "@effect/atom-react"
import type {
  DiffSide,
  PullRequest,
  PullRequestRef,
  PullRequestState,
  PullRequestWorkspace,
  Revision,
} from "@glass/contracts"
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
  PanelsTopLeft,
  RotateCw,
  Route,
  ScanSearch,
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { ActivityRecorder } from "./activity"
import { AgentReviewBanner, AgentReviewButton } from "./AgentReview"
import { AgentReviewCard } from "./AgentReviewCard"
import { AgentReviewPanel } from "./AgentReviewPanel"
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
import { isOpen, StatusChips } from "./PullRequestStatus"
import { type ChangesOrder, type WorkspaceTab, workspaceViewAtom } from "./reviewsArea"
import { ReviewShortcutsDialog } from "./ReviewShortcutsDialog"
import { ShortSha } from "./shortSha"
import type { AskStore } from "./useAsks"
import { type DraftStore, useDraftCount, useDraftsLocked } from "./useDrafts"
import { useFullFiles } from "./useFullFiles"
import type { ReplyStore } from "./useReplies"
import type { Resolutions } from "./useResolutions"
import { type ViewedFilesStore, useViewedFiles } from "./useViewedFiles"
import { useReviewShortcuts } from "./useReviewShortcuts"
import { TourView, type TourViewHandle } from "./TourView"
import { readTour } from "./tourReading"
import { useTour } from "./useTour"
import { useAgentReview } from "./useAgentReview"
import { positionOf } from "./reviewPosition"
import { rememberPlace } from "./savedPlace"
import {
  OutdatedTourBanner,
  RewriteTour,
  TourCard,
  TourSidebar,
  useTourReadyToast,
} from "./TourSidebar"

const wideWorkspaceQuery = "(min-width: 1024px)"

type FilePanelTab = "tree" | "notes" | "tour" | "agent-review"

export function Workspace(props: {
  workspace: PullRequestWorkspace
  activity: ActivityRecorder
  drafts: DraftStore
  asks: AskStore
  replies: ReplyStore
  resolutions: Resolutions
  viewedFiles: ViewedFilesStore
  reloading: boolean
  changedOnGitHub: boolean
  onReload: () => void
  onBack: () => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const { pullRequest, revision, files, discussions } = props.workspace
  const tour = useTour(pullRequest.ref, revision)
  const agentReview = useAgentReview(pullRequest.ref, revision, isOpen(pullRequest))
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
  const [all, setAll] = useState<CollapseChoices["all"]>("expanded")
  const view = useRef<ViewHandle>(null)
  const tourView = useRef<TourViewHandle>(null)
  const [panelTab, setPanelTab] = useState<FilePanelTab>("tree")
  const fullFiles = useFullFiles(pullRequest.ref, revision)
  const { activity, drafts, asks, replies, resolutions } = props
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
    () => (saved === null ? null : readTour(layout.files, saved)),
    [layout, saved],
  )

  const tourShown = chosenOrder === "tour" ? reading : null
  const shown = tourShown?.files ?? layout.files

  const tourInChanges = tab === "changes" && tourShown !== null

  const [fullScreenChosen, setFullScreen] = useState(false)
  const fullScreen = fullScreenChosen && tourInChanges

  const current = shown.find((entry) => entry.file.path === currentPath)?.file ?? shown[0]?.file

  const viewingPath = tab === "changes" ? (current?.path ?? null) : null

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

  useReviewShortcuts(
    tourInChanges
      ? [
          { key: "f", run: () => setFullScreen(!fullScreen) },
          ...(fullScreen ? [{ key: "Escape", run: () => setFullScreen(false) }] : []),
          {
            key: "]",
            run: () => openChapter((tourView.current?.currentChapter() ?? 0) + 1, "instant"),
          },
          {
            key: "[",
            run: () => openChapter((tourView.current?.currentChapter() ?? 0) - 1, "instant"),
          },
        ]
      : [],
  )

  useTourReadyToast(tour.latest, reading, openChapter)

  const openInChanges = (path: string) =>
    flushSync(() => {
      setView((previous) => ({ ...previous, tab: "changes", file: path }))
      setOpened((paths) => (paths.get(path) === true ? paths : new Map(paths).set(path, true)))
    })

  const showFile = (path: string, behavior: "instant" | "smooth" = "smooth") => {
    openInChanges(path)

    if (tourShown !== null) tourView.current?.showFile(path, behavior)
    else view.current?.scrollTo({ type: "item", id: path, align: "start", behavior })
  }

  const showLine = (path: string, side: DiffSide, line: number) => {
    openInChanges(path)

    if (tourShown !== null) {
      tourView.current?.showLine(path, side, line)

      return
    }

    view.current?.setSelectedLines({
      id: path,
      range: { start: line, end: line, side: annotationSides[side] },
    })
    view.current?.scrollTo({
      type: "line",
      id: path,
      lineNumber: line,
      side: annotationSides[side],
      align: "center",
      behavior: "smooth-auto",
    })
  }

  const show: ShowNote = { file: showFile, line: showLine }

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

  // The Tour order hides the file panel, so reading the Agent review switches back to paths.
  const readAgentReview = () => {
    flushSync(() => {
      setPanelTab("agent-review")
      setFilePanelOpen(true)
      setView((previous) => ({ ...previous, tab: "changes", order: "path" }))
    })

    returnToCurrent(false)
  }

  // Without a review there is no Agent review tab, so the panel falls back to the tree.
  const shownPanelTab =
    panelTab === "agent-review" && agentReview.review === null ? "tree" : panelTab

  const additions = files.reduce((sum, file) => sum + file.additions, 0)
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const filePanelLabel = filePanelOpen ? "Hide file panel" : "Show file panel"

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
      className={cn(
        "min-h-0 flex-1 gap-0",
        // Full screen covers the app rail, the Queue bar and the PR header; only the title strip stays.
        fullScreen && "fixed inset-0 z-40 bg-background",
      )}
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
          open={<OpenPullRequestDialog current={pullRequest.ref} onOpen={props.onOpen} />}
          review={
            <FinishReview
              key={pullRequest.id}
              store={drafts}
              viewerIsAuthor={pullRequest.viewerIsAuthor}
              onReload={props.onReload}
            />
          }
          tabs={
            <TabsList variant="line" aria-label="PR workspace" className="shrink-0">
              <WorkspaceTabTrigger value="overview" label="Overview" icon={PanelsTopLeft} />
              <WorkspaceTabTrigger value="changes" label="Changes" icon={FileDiff} />
              <WorkspaceTabTrigger value="files" label="Files" icon={FolderTree} />
            </TabsList>
          }
        />
      )}
      <ProblemBanner problem={fullFiles.problem} />
      <ViewedFilesProblem store={props.viewedFiles} onReload={props.onReload} />
      <div className="flex min-h-0 flex-1">
        <aside
          id={filePanelId}
          className={cn(
            "flex w-80 shrink-0 flex-col border-r",
            (!filePanelOpen || tab === "files" || tourInChanges) && "hidden",
          )}
        >
          <Tabs value={shownPanelTab} onValueChange={setPanelTab} className="min-h-0 flex-1 gap-0">
            <TabsList
              variant="line"
              aria-label="File panel"
              className="mt-1 w-full justify-start border-b px-2"
            >
              <TabsTrigger value="tree" className="flex-none">
                <FolderTree aria-hidden />
                Tree
              </TabsTrigger>
              <TabsTrigger value="notes" className="flex-none">
                <MessageCircle aria-hidden />
                Notes
                <span className="text-xs text-muted-foreground tabular-nums">
                  {discussions.onLines.length + draftCount}
                </span>
              </TabsTrigger>
              <TabsTrigger value="tour" className="flex-none">
                <Route aria-hidden />
                Tour
              </TabsTrigger>
              {agentReview.review !== null && (
                // Icon only: the panel is too narrow for a fourth labeled tab.
                <TabsTrigger
                  value="agent-review"
                  aria-label="Agent review"
                  title="Agent review"
                  className="flex-none"
                >
                  <ScanSearch aria-hidden />
                </TabsTrigger>
              )}
            </TabsList>
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
            <TabsContent value="agent-review" className="flex min-h-0 flex-col">
              {agentReview.review !== null && <AgentReviewPanel review={agentReview.review} />}
            </TabsContent>
            <TabsContent value="tour" className="flex min-h-0 flex-col">
              <TourSidebar
                tour={tour}
                reading={reading}
                viewedFiles={props.viewedFiles}
                outdatedBanner={
                  !tourInChanges &&
                  tour.outdated !== null && <OutdatedTourBanner revision={tour.outdated} />
                }
                onShowChapter={openChapter}
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
              {reading !== null && <TourCard reading={reading} onShowChapter={openChapter} />}
              <AgentReviewCard controls={agentReview} onRead={readAgentReview} />
              <Description html={pullRequest.descriptionHtml} />
              <DraftList store={drafts} onShow={(draft) => showDraft(show, draft)} />
              <Timeline items={discussions.timeline} />
              <OutdatedDiscussions
                discussions={discussions.outdated}
                replies={replies}
                resolutions={resolutions}
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
            fullScreen={tourInChanges ? { on: fullScreen, onChange: setFullScreen } : null}
            agentReview={<AgentReviewButton controls={agentReview} />}
          />
          <AgentReviewBanner controls={agentReview} onRead={readAgentReview} />
          {tourInChanges && tour.outdated !== null && (
            <div className="border-b px-6 py-3">
              <OutdatedTourBanner
                revision={tour.outdated}
                action={<RewriteTour tour={tour} variant="outline" />}
              />
            </div>
          )}
          {tourShown !== null ? (
            <TourView
              key={revisionKey}
              initialPath={currentPath}
              ref={tourView}
              reading={tourShown}
              discussions={discussions.onLines}
              drafts={drafts}
              asks={asks}
              replies={replies}
              resolutions={resolutions}
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
              />
            )
          )}
        </TabsContent>
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
      <footer className="flex shrink-0 justify-end border-t px-3 py-1.5">
        <ReviewShortcutsDialog />
      </footer>
    </Tabs>
  )
}

function WorkspaceTabTrigger(props: { value: WorkspaceTab; label: string; icon: LucideIcon }) {
  const Icon = props.icon

  return (
    <TabsTrigger value={props.value} className="flex-none px-2">
      <Icon aria-hidden />
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
    <header className="flex flex-col gap-2 border-b px-6 pt-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-nowrap">
        <BackToPullRequests onBack={props.onBack} disabled={props.busy} />
        <h1 className="order-first min-w-0 basis-full text-lg font-semibold tracking-tight wrap-anywhere lg:order-none lg:flex-1 lg:truncate">
          {pullRequest.title} <span className="font-normal text-muted-foreground">#{number}</span>
        </h1>
        <div className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted-foreground">
          {props.open}
          <span>
            Head <ShortSha sha={revision.head} />
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={props.onReload}
            disabled={props.busy}
            className={cn(
              props.changedOnGitHub &&
                "border-amber-500/60 bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200",
            )}
            title={
              props.changedOnGitHub
                ? "Changed on GitHub since Glass loaded it. Reload to see it as it is now."
                : "Reopen at the pull request's current revision"
            }
          >
            <RotateCw className={props.reloading ? "animate-spin" : undefined} aria-hidden />
            Reload
          </Button>
          {props.review}
        </div>
      </div>
      <div className="flex flex-col items-start gap-2 pb-2 xl:flex-row xl:items-center xl:gap-4">
        <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground xl:w-auto">
          <StateBadge pullRequest={pullRequest} />
          <span>
            {owner}/{repo}
          </span>
          <span aria-hidden>·</span>
          <span className="font-medium text-foreground">{pullRequest.author}</span>
          <span aria-hidden>·</span>
          <Branch name={pullRequest.baseBranch} />
          <span aria-label="from">←</span>
          <Branch name={pullRequest.headBranch} />
          <span aria-hidden>·</span>
          <StatusChips pullRequest={pullRequest} />
        </div>
        {props.tabs}
      </div>
    </header>
  )
}

const badges: Record<
  PullRequestState,
  { readonly label: string; readonly icon: LucideIcon; readonly className: string }
> = {
  open: { label: "Open", icon: GitPullRequest, className: "bg-emerald-600 text-white" },
  draft: { label: "Draft", icon: GitPullRequestDraft, className: "bg-zinc-500 text-white" },
  closed: { label: "Closed", icon: GitPullRequestClosed, className: "bg-red-600 text-white" },
  merged: { label: "Merged", icon: GitMerge, className: "bg-violet-600 text-white" },
}

function StateBadge(props: { pullRequest: PullRequest }) {
  const { label, icon: Icon, className } = badges[props.pullRequest.state]

  return (
    <Badge className={className}>
      <Icon data-icon="inline-start" aria-hidden />
      {label}
    </Badge>
  )
}

function Branch(props: { name: string }) {
  return (
    <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
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

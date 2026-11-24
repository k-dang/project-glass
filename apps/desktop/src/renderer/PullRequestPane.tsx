import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { PullRequest, PullRequestRef, PullRequestWorkspace } from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { FileDiff, Maximize2, RotateCw } from "lucide-react"
import { useCallback, useContext, useMemo, useRef } from "react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TooltipHint } from "@/components/ui/tooltip"
import { defaultDisplay, DiffView, useOpenedFiles, type ViewHandle } from "./ChangedFilesView"
import { layOut, noneCollapsedWhenSuggested } from "./changesView"
import { DescriptionBody } from "./GitHubHtml"
import { MergePullRequest } from "./MergePullRequest"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem } from "./problems"
import { LineCounts } from "./LineCounts"
import { useLiveStatus } from "./liveStatus"
import { plural } from "./plural"
import { ChecksChip, ConflictsChip, ReviewersChip } from "./PullRequestStatus"
import { preloadAtom, reloadPreloaded } from "./reviewsArea"
import { SidePanel } from "./SidePanel"
import { Timeline } from "./Timeline"
import { useFullFiles } from "./useFullFiles"
import type { Reactions } from "./workspaceFeedback"

const paneWidthAtom = Atom.make(560).pipe(Atom.keepAlive)

export function PullRequestPane(props: { pullRequest: PullRequestRef; onClose: () => void }) {
  const { owner, repo, number } = props.pullRequest
  const result = useAtomValue(preloadAtom(props.pullRequest))
  const registry = useContext(RegistryContext)
  const reload = () => void reloadPreloaded(registry, props.pullRequest)
  const navigate = useNavigate()
  const problem = settledProblem(result)
  const loaded = Option.getOrNull(AsyncResult.value(result))
  const pullRequest = useLiveStatus(loaded?.workspace.pullRequest ?? null)

  return (
    <SidePanel
      name="Pull request"
      heading={
        <span className="text-sm font-normal text-muted-foreground">
          {owner}/{repo}{" "}
          {pullRequest === null ? (
            `#${number}`
          ) : (
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="text-emerald-500 hover:underline"
            >
              #{number}
            </a>
          )}
        </span>
      }
      actions={
        <>
          <TooltipHint content="Reload">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Reload"
              onClick={reload}
              disabled={result.waiting}
            >
              <RotateCw className={result.waiting ? "animate-spin" : undefined} aria-hidden />
            </Button>
          </TooltipHint>
          {loaded !== null && pullRequest !== null && (
            <MergePullRequest
              key={pullRequest.id}
              pullRequest={pullRequest}
              revision={loaded.workspace.revision}
              onReload={reload}
            />
          )}
          <TooltipHint content="Open review">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open review"
              onClick={() =>
                void navigate({ to: "/reviews/$owner/$repo/$number", params: props.pullRequest })
              }
            >
              <Maximize2 aria-hidden />
            </Button>
          </TooltipHint>
        </>
      }
      width={paneWidthAtom}
      onClose={props.onClose}
    >
      {loaded !== null && pullRequest !== null ? (
        <LoadedPullRequest
          workspace={loaded.workspace}
          reactions={loaded.reactions}
          pullRequest={pullRequest}
        />
      ) : problem !== null ? (
        <div className="px-5 py-4">
          <ProblemAlert problem={problem} action={{ label: "Try again", run: reload }} />
        </div>
      ) : (
        <output aria-label="Loading pull request" className="flex flex-col gap-3 px-5 py-4">
          <Skeleton className="h-5 w-3/5" />
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-16 w-full" />
        </output>
      )}
    </SidePanel>
  )
}

function LoadedPullRequest(props: {
  workspace: PullRequestWorkspace
  reactions: Reactions
  pullRequest: PullRequest
}) {
  const { pullRequest } = props
  const { files, timeline } = props.workspace

  return (
    <>
      <div className="flex flex-col gap-2 border-b px-5 py-3 text-sm">
        <h3 className="truncate text-base font-semibold">{pullRequest.title}</h3>
        <div className="flex min-w-0 items-center gap-3 text-xs text-muted-foreground">
          <span className="min-w-0 truncate font-mono">
            {pullRequest.baseBranch} ← {pullRequest.headBranch}
          </span>
          <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
            <FileDiff aria-hidden className="size-3.5" />
            {plural(files.length, "file")}
            <LineCounts
              additions={files.reduce((sum, file) => sum + file.additions, 0)}
              deletions={files.reduce((sum, file) => sum + file.deletions, 0)}
            />
          </span>
        </div>
      </div>
      <Tabs defaultValue="summary" className="min-h-0 flex-1 gap-0">
        <div className="flex shrink-0 items-center gap-2 border-b px-5 py-2">
          <TabsList aria-label="Pull request">
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
          </TabsList>
          <span className="ml-auto">
            <ChecksChip pullRequest={pullRequest} />
          </span>
        </div>
        <TabsContent
          value="summary"
          className="flex min-h-0 flex-col gap-4 overflow-y-auto px-5 py-4"
        >
          <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <span className="mr-1">by {pullRequest.author}</span>
            <ReviewersChip pullRequest={pullRequest} />
            <ConflictsChip pullRequest={pullRequest} />
          </div>
          <DescriptionBody html={pullRequest.descriptionHtml} />
          <Timeline items={timeline} reactions={props.reactions} />
        </TabsContent>
        <TabsContent value="code" className="flex min-h-0 min-w-0 flex-col">
          <PaneChanges workspace={props.workspace} />
        </TabsContent>
      </Tabs>
    </>
  )
}

function PaneChanges(props: { workspace: PullRequestWorkspace }) {
  const { pullRequest, revision } = props.workspace
  const { files } = useMemo(() => layOut(props.workspace.files), [props.workspace.files])
  const fullFiles = useFullFiles(pullRequest.ref, revision)
  const view = useRef<ViewHandle<undefined>>(null)
  const { opened, setFilesOpen } = useOpenedFiles(useCallback(() => view.current, []))

  if (files.length === 0)
    return <p className="px-5 py-4 text-sm text-muted-foreground">No files changed.</p>

  return (
    <>
      {fullFiles.problem !== null && (
        <div className="border-b px-5 py-3">
          <ProblemAlert problem={fullFiles.problem} />
        </div>
      )}
      <DiffView
        ref={view}
        initialPath={null}
        files={files}
        display={defaultDisplay}
        opened={opened}
        all="expanded"
        collapsedWhenSuggested={noneCollapsedWhenSuggested}
        onOpenChange={(path, open) => setFilesOpen([path], open)}
        summaries={null}
        renderGutterUtility={null}
        loadDiffFiles={fullFiles.loadDiffFiles}
      />
    </>
  )
}

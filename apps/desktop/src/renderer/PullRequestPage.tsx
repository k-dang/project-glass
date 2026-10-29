import { RegistryContext, useAtomValue } from "@effect/atom-react"
import type { PullRequestRef } from "@glass/contracts"
import { getRouteApi } from "@tanstack/react-router"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { cn } from "cn"
import {
  FileDiff,
  FolderTree,
  type LucideIcon,
  MessageCircle,
  PanelsTopLeft,
  Route,
} from "lucide-react"
import { type ReactNode, useCallback, useContext } from "react"
import { Skeleton } from "@/components/ui/skeleton"
import { BackToPullRequests } from "./BackToPullRequests"
import { OpenPullRequestDialog } from "./OpenPullRequestDialog"
import { ProblemAlert, Problems } from "./ProblemAlert"
import { QueueBar } from "./QueueBar"
import { type Problem, settledProblem } from "./problems"
import {
  changedOnGitHubAtom,
  listSearchAtom,
  openWorkspaceAtom,
  reloadPullRequest,
  retryOpen,
  resumeNoticeAtom,
} from "./reviewsArea"
import { Workspace } from "./Workspace"

const route = getRouteApi("/reviews/$owner/$repo/$number")

export function PullRequestPage() {
  const ref = route.useParams()
  const navigate = route.useNavigate()
  const registry = useContext(RegistryContext)
  const result = useAtomValue(openWorkspaceAtom)
  const resumeNotice = useAtomValue(resumeNoticeAtom)
  const list = useAtomValue(listSearchAtom)
  const changed = Option.getOrNull(AsyncResult.value(useAtomValue(changedOnGitHubAtom)))
  const reload = useCallback(() => void reloadPullRequest(registry), [registry])

  const back = () => void navigate({ to: "/reviews", search: list })

  const openOther = (other: PullRequestRef) =>
    void navigate({ to: "/reviews/$owner/$repo/$number", params: other })

  const problem = settledProblem(result)
  const open = Option.getOrNull(AsyncResult.value(result))

  return (
    <>
      <QueueBar current={ref} onOpen={openOther} />
      {resumeNotice !== null && open !== null && (
        <output className="shrink-0 border-b px-6 py-3 text-sm text-muted-foreground">
          {resumeNotice}
        </output>
      )}
      {open === null ? (
        problem === null ? (
          <LoadingState pullRequest={ref} onBack={back} />
        ) : (
          <OpenFailed
            problem={problem}
            onRetry={() => retryOpen(registry)}
            onBack={back}
            open={<OpenPullRequestDialog current={ref} onOpen={openOther} />}
          />
        )
      ) : (
        <>
          {problem !== null && (
            <Problems>
              <ProblemAlert problem={problem} />
            </Problems>
          )}
          <Workspace
            key={`${ref.owner}/${ref.repo}#${ref.number}`}
            workspace={open.workspace}
            activity={open.activity}
            drafts={open.drafts}
            asks={open.asks}
            replies={open.replies}
            resolutions={open.resolutions}
            viewedFiles={open.viewedFiles}
            reloading={result.waiting}
            changedOnGitHub={changed === open.workspace}
            onReload={reload}
            onBack={back}
            onOpen={openOther}
          />
        </>
      )}
    </>
  )
}

function LoadingState(props: { pullRequest: PullRequestRef; onBack: () => void }) {
  const { owner, repo, number } = props.pullRequest

  return (
    <output aria-label="Loading pull request" className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-col gap-2 border-b px-6 pt-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 lg:flex-nowrap">
          <BackToPullRequests onBack={props.onBack} />
          <div className="order-first flex min-w-0 basis-full items-center gap-2 text-lg lg:order-none lg:flex-1">
            <Skeleton className="h-5 w-2/5" />
            <span className="text-muted-foreground">#{number}</span>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Skeleton className="h-7 w-20" />
            <Skeleton className="h-7 w-28" />
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 pb-2 xl:flex-row xl:items-center xl:gap-4">
          <div className="flex w-full min-w-0 flex-1 flex-wrap items-center gap-2 text-sm text-muted-foreground xl:w-auto">
            <Skeleton className="h-5 w-14 rounded-full" />
            <span className="truncate">
              {owner}/{repo}
            </span>
            <span aria-hidden>·</span>
            <Skeleton className="h-4 w-20" />
            <span aria-hidden>·</span>
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex shrink-0 gap-4" aria-hidden>
            <TabStub icon={PanelsTopLeft} label="Overview" selected />
            <TabStub icon={FileDiff} label="Changes" />
            <TabStub icon={FolderTree} label="Files" />
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1" aria-hidden>
        <div className="hidden w-80 shrink-0 flex-col border-r lg:flex">
          <div className="mt-1 flex gap-4 border-b px-4 pt-2">
            <TabStub icon={FolderTree} label="Tree" selected />
            <TabStub icon={MessageCircle} label="Notes" />
            <TabStub icon={Route} label="Tour" />
          </div>
          <div className="flex flex-col gap-2.5 p-4">
            {treeRows.map(({ depth, width }, index) => (
              <Skeleton
                key={index}
                className="h-3.5"
                style={{ width: `${width}%`, marginLeft: `${depth * 12}px` }}
              />
            ))}
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center px-6 py-2">
            <Skeleton className="h-8 w-32" />
          </div>
          <div className="flex flex-col gap-8 px-6 py-8">
            <div className="flex flex-col gap-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-4/5" />
            </div>
            {[0, 1, 2].map((index) => (
              <div key={index} className="flex items-start gap-3">
                <Skeleton className="size-6 shrink-0 rounded-full" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton className="h-3.5 w-1/4" />
                  <Skeleton className="h-3.5 w-3/4" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </output>
  )
}

const treeRows = [
  { depth: 0, width: 60 },
  { depth: 1, width: 75 },
  { depth: 2, width: 45 },
  { depth: 0, width: 80 },
  { depth: 1, width: 55 },
  { depth: 2, width: 70 },
  { depth: 0, width: 40 },
  { depth: 1, width: 65 },
]

function TabStub(props: { icon: LucideIcon; label: string; selected?: boolean }) {
  return (
    <span
      className={cn(
        "flex items-center gap-1.5 border-b-2 border-transparent pb-1 text-sm text-muted-foreground/60",
        props.selected && "border-foreground/30",
      )}
    >
      <props.icon className="size-4" />
      {props.label}
    </span>
  )
}

function OpenFailed(props: {
  problem: Problem
  onRetry: () => void
  onBack: () => void
  open: ReactNode
}) {
  return (
    <div className="page-content flex flex-col items-start gap-4 py-6">
      <div className="flex items-center gap-2">
        <BackToPullRequests onBack={props.onBack} />
        {props.open}
      </div>
      <div className="w-full">
        <ProblemAlert problem={props.problem} action={{ label: "Try again", run: props.onRetry }} />
      </div>
    </div>
  )
}

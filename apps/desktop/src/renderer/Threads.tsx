import {
  RegistryContext,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Thread,
  type ThreadNeedsYou,
  isGone,
  isOutOfReach,
  type PlaceTag,
  repositoryKey,
  type SandboxStatus,
} from "@glass/contracts"
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { DateTime, Exit, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  ChevronRight,
  CircleDashed,
  CircleHelp,
  FolderGit2,
  GitBranch,
  type LucideIcon,
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
  Trash2,
  Undo2,
} from "lucide-react"
import { cn } from "cn"
import {
  createContext,
  type ReactNode,
  type RefObject,
  use,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react"
import { createPortal } from "react-dom"
import { Button, buttonVariants } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import { TooltipHint } from "@/components/ui/tooltip"
import {
  bringBackThreadAtom,
  threadsAtom,
  threadsPanelOpenAtom,
  groupThreads,
  placeNames,
  removalWarningsAtom,
  removeThread,
  removeSettledThreads,
  settledThreadsAtom,
  settledOpenAtom,
  workingThreadsAtom,
} from "./threadsArea"
import { AgentHarnessIcon } from "./AgentHarnessIcon"
import { threadsNeedingYouAtom } from "./needsYou"
import { ThreadPullRequestBadge, useThreadPullRequest } from "./ThreadPullRequest"
import { useMinuteClock } from "./Inbox"
import { ago } from "./PullRequestRow"
import { turnEndingLooks, warningTone } from "./status"
import { harnessNames } from "./harnesses"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ThreadName } from "./ThreadName"
import { fadeIn } from "./fadeIn"
import { settledProblem, streamProblem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"
import { useActions } from "./actions"
import { ShellPanelSlot } from "./shellPanelSlot"
import { shortcutLabel } from "./shortcutLabel"

const groupNames: Record<PlaceTag, string> = { ...placeNames, sandbox: "Sandboxes" }

const noThreads: ReadonlySet<string> = new Set()

interface Marker {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
}

const workingMarker: Marker = {
  label: "Working",
  icon: CircleDashed,
  tone: "text-sky-600 dark:text-sky-400",
}

const markerOf = ({ reasons }: ThreadNeedsYou): Marker => {
  const reason = reasons.find(Predicate.isTagged("WaitingRequests")) ?? reasons[0]

  return Match.valueTags(reason, {
    WaitingRequests: () => ({ label: "Waiting on you", icon: CircleHelp, tone: warningTone }),
    TurnFinished: ({ ended }) => turnEndingLooks[ended.ending._tag],
  })
}

const expiryFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
})

const sandboxLine = ({ reach, expiresAt }: SandboxStatus) => {
  if (isGone(reach)) return `Sandbox ${reach}`

  const expiry =
    expiresAt === null ? null : `Expires ${expiryFormat.format(DateTime.toDateUtc(expiresAt))}`

  return reach === "unreachable"
    ? ["Can't reach its Sandbox", expiry].filter(Boolean).join(" · ")
    : expiry
}

const threadLink =
  "flex flex-col gap-0.5 rounded-lg px-2 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"

const panelStyles: Record<
  "inline" | "beside",
  { aside: string; header: string; heading: "h1" | "h2"; title: string }
> = {
  inline: {
    aside: "flex w-64 shrink-0 flex-col gap-4 border-r px-3 py-4",
    header: "flex items-center justify-between pl-2",
    heading: "h1",
    title: "text-sm font-semibold",
  },
  beside: {
    aside: "flex w-64 shrink-0 flex-col gap-2 pr-2 pb-2",
    header:
      "title-strip flex shrink-0 items-center justify-between pl-[max(0.5rem,calc(env(titlebar-area-x,0px)-3rem))]",
    heading: "h2",
    title: "text-base font-semibold",
  },
}

const panelId = "threads-panel"

const panelToggleId = "threads-panel-toggle"

export function ThreadsLayout() {
  const [panelOpen, setPanelOpen] = useAtom(threadsPanelOpenAtom)
  const panelSlot = use(ShellPanelSlot)
  const styles = panelSlot === null ? panelStyles.inline : panelStyles.beside

  const togglePanel = () => {
    if (panelOpen && document.getElementById(panelId)?.contains(document.activeElement))
      document.getElementById(panelToggleId)?.focus()

    setPanelOpen((open) => !open)
  }

  useActions([
    {
      id: "threads-panel",
      title: panelOpen ? "Hide the Threads list" : "Show the Threads list",
      group: "Thread",
      icon: panelOpen ? PanelLeftClose : PanelLeftOpen,
      shortcut: { key: "b", mod: true, allowInEditable: true },
      run: togglePanel,
    },
  ])

  const panel = (
    <aside id={panelId} aria-label="Threads panel" hidden={!panelOpen} className={styles.aside}>
      <div className={styles.header}>
        <styles.heading className={styles.title}>Threads</styles.heading>
        <NewThreadLink />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ThreadList />
      </div>
    </aside>
  )

  return (
    <main aria-label="Threads" className="flex min-h-0 flex-1">
      {panelSlot === null ? panel : createPortal(panel, panelSlot)}
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </main>
  )
}

export function ThreadsPanelToggle() {
  const [panelOpen, setPanelOpen] = useAtom(threadsPanelOpenAtom)
  const panelLabel = panelOpen ? "Hide Threads panel" : "Show Threads panel"
  const PanelIcon = panelOpen ? PanelLeftClose : PanelLeftOpen

  return (
    <TooltipHint
      content={
        <span className="flex items-center gap-2">
          {panelLabel} <Kbd>{shortcutLabel("B")}</Kbd>
        </span>
      }
      side="bottom"
    >
      <Button
        id={panelToggleId}
        variant="ghost"
        size="icon-sm"
        aria-label={panelLabel}
        aria-expanded={panelOpen}
        aria-controls={panelId}
        onClick={() => setPanelOpen((open) => !open)}
      >
        <PanelIcon aria-hidden />
      </Button>
    </TooltipHint>
  )
}

function NewThreadLink() {
  return (
    <TooltipHint
      content={
        <span className="flex items-center gap-2">
          New Thread <Kbd>{shortcutLabel("N")}</Kbd>
        </span>
      }
      side="bottom"
    >
      <Link
        to="/threads/new"
        aria-label="New Thread"
        className={cn(
          buttonVariants({ variant: "ghost", size: "icon-sm" }),
          "[app-region:no-drag]",
        )}
      >
        <SquarePen aria-hidden />
      </Link>
    </TooltipHint>
  )
}

function ThreadList() {
  const threads = useAtomValue(threadsAtom)
  const retry = useAtomRefresh(threadsAtom)
  const now = useMinuteClock()

  const settledIds = Option.getOrElse(
    AsyncResult.value(useAtomValue(settledThreadsAtom)),
    () => noThreads,
  )

  return AsyncResult.builder(threads)
    .onInitial(() => (
      <output className="px-2 text-sm text-muted-foreground">Loading Threads…</output>
    ))
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Retry", run: retry }} />
    ))
    .onSuccess((list) => <ThreadNav list={list} settledIds={settledIds} now={now} />)
    .render()
}

const ListMounted = createContext<RefObject<boolean>>({ current: false })

function useArrival<E extends HTMLElement>(animates: boolean) {
  const mounted = use(ListMounted)
  const ref = useRef<E>(null)

  useEffect(() => {
    if (animates && mounted.current && ref.current !== null)
      fadeIn(ref.current, { translate: "0 0.375rem" }, 200)
  }, [animates, mounted])

  return ref
}

function ThreadNav(props: {
  list: ReadonlyArray<Thread>
  settledIds: ReadonlySet<string>
  now: Date
}) {
  const { settledIds, now } = props
  const shown = props.list.filter((thread) => !thread.forReview)
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true

    return () => {
      mounted.current = false
    }
  }, [])

  const going = shown.filter(({ id }) => !settledIds.has(id))
  const settled = shown.filter(({ id }) => settledIds.has(id))

  return (
    <ListMounted value={mounted}>
      {shown.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">No Threads yet.</p>
      ) : (
        <nav aria-label="Threads list" className="flex min-h-full flex-col gap-4">
          {groupThreads(going).map(({ machine, threads: onMachine }) => (
            <section key={machine} aria-label={groupNames[machine]} className="flex flex-col gap-1">
              <GroupHeading>{groupNames[machine]}</GroupHeading>
              <ThreadRows threads={onMachine} now={now} settled={false} />
            </section>
          ))}
          {settled.length > 0 && <SettledSection threads={settled} now={now} />}
        </nav>
      )}
    </ListMounted>
  )
}

function GroupHeading(props: { children: ReactNode }) {
  const ref = useArrival<HTMLHeadingElement>(true)

  return (
    <h2
      ref={ref}
      className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase"
    >
      {props.children}
    </h2>
  )
}

function ThreadRows(props: { threads: ReadonlyArray<Thread>; now: Date; settled: boolean }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.threads.map((thread) => (
        <ThreadRow key={thread.id} thread={thread} now={props.now} settled={props.settled} />
      ))}
    </ul>
  )
}

function SettledSection(props: { threads: ReadonlyArray<Thread>; now: Date }) {
  const [open, setOpen] = useAtom(settledOpenAtom)
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  const openId = useParams({ strict: false }).threadId
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  const removeAll = async () => {
    setConfirming(false)
    setRemoving(true)

    await removeSettledThreads(registry, props.threads, ({ id }) => {
      if (id === openId) void navigate({ to: "/threads" })
    })

    setRemoving(false)
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section />}
      aria-label="Settled"
      className="mt-auto flex flex-col gap-1"
    >
      <div className="group/settled flex items-center pr-1">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/trigger flex w-full items-center gap-1 rounded-sm px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Settled
            <span className="tabular-nums">{props.threads.length}</span>
            <ChevronRight
              aria-hidden
              className="size-3.5 transition-transform duration-200 ease-out group-data-panel-open/trigger:rotate-90 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </h2>
        <TooltipHint content="Remove all">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Remove Settled Threads"
            disabled={removing}
            onClick={() => setConfirming(true)}
            className="opacity-0 group-hover/settled:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 aria-hidden />
          </Button>
        </TooltipHint>
      </div>
      <CollapsibleContent>
        <ThreadRows threads={props.threads} now={props.now} settled />
      </CollapsibleContent>
      <ConfirmationDialog
        open={confirming}
        title={
          props.threads.length === 1
            ? "Remove 1 Settled Thread?"
            : `Remove ${props.threads.length} Settled Threads?`
        }
        description="Glass removes each one without uncommitted changes, deleting its worktree or Sandbox and its transcript. Branches and their commits stay. Any with uncommitted changes stay listed for you to check."
        confirmLabel="Remove Threads"
        onConfirm={() => void removeAll()}
        onCancel={() => setConfirming(false)}
      />
    </Collapsible>
  )
}

const removalWarning = (thread: Thread, warning: "some" | "unchecked") => {
  const inSandbox = Predicate.isTagged(thread.place, "sandbox")

  if (warning === "unchecked")
    return inSandbox
      ? "Glass couldn't reach its Sandbox to check for uncommitted changes. Removing it deletes the Sandbox and everything in it."
      : `Glass couldn't check its worktree for uncommitted changes. Removing it discards any. The branch ${thread.name} and its commits stay.`

  return inSandbox
    ? "Its Sandbox has uncommitted changes, which removing it discards along with the Sandbox."
    : `Its worktree has uncommitted changes, which removing it discards. The branch ${thread.name} and its commits stay.`
}

const rowAction =
  "opacity-0 transition-none group-hover/row:opacity-100 group-hover/row:disabled:opacity-100 focus-visible:opacity-100"

function BringBackButton(props: { thread: Thread }) {
  const bringBack = useAtomSet(bringBackThreadAtom)

  return (
    <TooltipHint content="Bring back">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Bring back ${props.thread.name}`}
        onClick={() => bringBack(props.thread.id)}
        className={rowAction}
      >
        <Undo2 aria-hidden />
      </Button>
    </TooltipHint>
  )
}

function ThreadRow(props: { thread: Thread; now: Date; settled: boolean }) {
  const { thread } = props
  const arrival = useArrival<HTMLLIElement>(!props.settled)
  const navigate = useNavigate()
  const open = useParams({ strict: false }).threadId === thread.id
  const registry = useContext(RegistryContext)
  const warnings = useAtomValue(removalWarningsAtom(thread.id))
  const checkWarnings = useAtomSet(removalWarningsAtom(thread.id), { mode: "promiseExit" })

  const [confirming, setConfirming] = useState<"some" | "unchecked" | null>(null)

  const problem = settledProblem(warnings)
  const repositoryId = useId()
  const markerId = useId()

  const { sandbox } = thread
  const sandboxText = sandbox === null ? null : sandboxLine(sandbox)
  const originId = useId()
  const harnessId = useId()
  const pullRequestId = useId()
  const pullRequest = useThreadPullRequest(thread.id)

  const needsYou = useAtomValue(threadsNeedingYouAtom).get(thread.id)

  const working = Option.getOrElse(
    AsyncResult.value(useAtomValue(workingThreadsAtom)),
    () => noThreads,
  ).has(thread.id)

  const showsWorking = needsYou === undefined && working

  const marker = needsYou !== undefined ? markerOf(needsYou) : showsWorking ? workingMarker : null

  const removeNow = () => {
    setConfirming(null)

    if (open) void navigate({ to: "/threads" })

    void removeThread(registry, thread)
  }

  const start = async () => {
    const exit = await checkWarnings()

    if (Exit.isFailure(exit)) return

    const { uncommittedChanges } = exit.value

    if (uncommittedChanges === "none") removeNow()
    else setConfirming(uncommittedChanges)
  }

  return (
    <li ref={arrival} className="group/row relative">
      <Link
        to="/threads/$threadId"
        params={{ threadId: thread.id }}
        aria-label={thread.name}
        aria-describedby={[
          repositoryId,
          ...(marker === null ? [] : [markerId]),
          originId,
          ...(pullRequest === undefined ? [] : [pullRequestId]),
          harnessId,
        ].join(" ")}
        className={cn(threadLink, sandbox !== null && isOutOfReach(sandbox.reach) && "opacity-60")}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
          <span id={repositoryId} className="min-w-0 flex-1 truncate">
            {repositoryKey(thread.repository)}
          </span>
          {marker === null ? (
            <span className="shrink-0 tabular-nums">
              {ago(DateTime.toDateUtc(thread.createdAt), props.now)}
            </span>
          ) : (
            <span
              key={marker.label}
              id={markerId}
              className={cn(
                "flex shrink-0 items-center gap-1 font-medium transition-[opacity,filter] duration-200 ease-out starting:opacity-0 starting:blur-[2px]",
                marker.tone,
              )}
            >
              <marker.icon
                aria-hidden
                className={cn(
                  "size-3.5",
                  showsWorking &&
                    "animate-spin [animation-duration:2.5s] motion-reduce:animate-none",
                )}
              />
              {marker.label}
            </span>
          )}
        </span>
        <ThreadName
          name={thread.name}
          className={cn("truncate text-sm font-semibold", showsWorking && "text-muted-foreground")}
        />
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {sandboxText === null ? (
            <>
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span id={originId} className="min-w-0 flex-1 truncate">
                from {thread.baseBranch}
              </span>
            </>
          ) : (
            <span
              id={originId}
              className={cn(
                "min-w-0 flex-1 truncate",
                isGone(sandbox?.reach) && "text-destructive",
              )}
            >
              {sandboxText}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1.5 group-hover/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0">
            {pullRequest !== undefined && (
              <ThreadPullRequestBadge id={pullRequestId} pullRequest={pullRequest} />
            )}
            <AgentHarnessIcon harness={thread.harness} className="size-3" />
            <span id={harnessId} className="sr-only">
              {harnessNames[thread.harness]}
            </span>
          </span>
        </span>
      </Link>
      <div className="absolute right-1 bottom-1 flex gap-0.5">
        {props.settled && <BringBackButton thread={thread} />}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${thread.name}`}
          disabled={warnings.waiting}
          onClick={() => void start()}
          className={rowAction}
        >
          <Trash2 aria-hidden />
        </Button>
      </div>
      {problem !== null && (
        <p role="alert" className="px-2 pt-0.5 text-xs text-destructive">
          {problem.detail}
        </p>
      )}
      <ConfirmationDialog
        open={confirming !== null}
        title={`Remove ${thread.name}?`}
        description={confirming === null ? "" : removalWarning(thread, confirming)}
        confirmLabel="Remove Thread"
        onConfirm={removeNow}
        onCancel={() => setConfirming(null)}
      />
    </li>
  )
}

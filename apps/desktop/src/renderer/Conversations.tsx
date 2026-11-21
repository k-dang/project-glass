import {
  RegistryContext,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Conversation,
  type ConversationNeedsYou,
  isGone,
  readOnlyExplanation,
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
import { useContext, useId, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Kbd } from "@/components/ui/kbd"
import { TooltipHint } from "@/components/ui/tooltip"
import {
  bringBackConversationAtom,
  conversationsAtom,
  conversationsPanelOpenAtom,
  groupConversations,
  placeNames,
  removalWarningsAtom,
  removeConversation,
  removeSettledConversations,
  settledConversationsAtom,
  settledOpenAtom,
  workingConversationsAtom,
} from "./conversationsArea"
import { AgentHarnessIcon } from "./AgentHarnessIcon"
import { conversationsNeedingYouAtom } from "./needsYou"
import { ConversationPullRequestBadge, useConversationPullRequest } from "./ConversationPullRequest"
import { useMinuteClock } from "./Inbox"
import { ago } from "./PullRequestRow"
import { turnEndingLooks, warningTone } from "./status"
import { harnessNames } from "./harnesses"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { settledProblem, streamProblem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"
import { useActions } from "./actions"
import { shortcutLabel } from "./shortcutLabel"

const groupNames: Record<PlaceTag, string> = { ...placeNames, sandbox: "Sandboxes" }

const noConversations: ReadonlySet<string> = new Set()

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

const markerOf = ({ reasons }: ConversationNeedsYou): Marker => {
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

  if (reach === "incompatible") return "Sandbox on another Glass version"

  const expiry =
    expiresAt === null ? null : `Expires ${expiryFormat.format(DateTime.toDateUtc(expiresAt))}`

  return reach === "unreachable"
    ? ["Can't reach its Sandbox", expiry].filter(Boolean).join(" · ")
    : expiry
}

const conversationLink =
  "flex flex-col gap-0.5 rounded-lg px-2 py-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"

const panelId = "conversations-panel"

const panelToggleId = "conversations-panel-toggle"

export function ConversationsLayout() {
  const [panelOpen, setPanelOpen] = useAtom(conversationsPanelOpenAtom)

  const togglePanel = () => {
    if (panelOpen && document.getElementById(panelId)?.contains(document.activeElement))
      document.getElementById(panelToggleId)?.focus()

    setPanelOpen((open) => !open)
  }

  useActions([
    {
      id: "conversations-panel",
      title: panelOpen ? "Hide the Conversations list" : "Show the Conversations list",
      group: "Conversation",
      icon: panelOpen ? PanelLeftClose : PanelLeftOpen,
      shortcut: { key: "b", mod: true, allowInEditable: true },
      run: togglePanel,
    },
  ])

  return (
    <main aria-label="Conversations" className="flex min-h-0 flex-1">
      <aside
        id={panelId}
        aria-label="Conversations panel"
        hidden={!panelOpen}
        className="flex w-64 shrink-0 flex-col gap-4 border-r px-3 py-4"
      >
        <div className="flex items-center justify-between pl-2">
          <h1 className="text-sm font-semibold">Conversations</h1>
          <NewConversationLink />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ConversationList />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </main>
  )
}

export function ConversationsPanelToggle() {
  const [panelOpen, setPanelOpen] = useAtom(conversationsPanelOpenAtom)
  const panelLabel = panelOpen ? "Hide Conversations panel" : "Show Conversations panel"
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

function NewConversationLink() {
  return (
    <TooltipHint
      content={
        <span className="flex items-center gap-2">
          New Conversation <Kbd>{shortcutLabel("N")}</Kbd>
        </span>
      }
      side="bottom"
    >
      <Link
        to="/conversations/new"
        aria-label="New Conversation"
        className={buttonVariants({ variant: "ghost", size: "icon-sm" })}
      >
        <SquarePen aria-hidden />
      </Link>
    </TooltipHint>
  )
}

function ConversationList() {
  const conversations = useAtomValue(conversationsAtom)
  const retry = useAtomRefresh(conversationsAtom)
  const now = useMinuteClock()

  const settledIds = Option.getOrElse(
    AsyncResult.value(useAtomValue(settledConversationsAtom)),
    () => noConversations,
  )

  return AsyncResult.builder(conversations)
    .onInitial(() => (
      <output className="px-2 text-sm text-muted-foreground">Loading Conversations…</output>
    ))
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Retry", run: retry }} />
    ))
    .onSuccess((list) => {
      const shown = list.filter((conversation) => !conversation.forReview)
      const going = shown.filter(({ id }) => !settledIds.has(id))
      const settled = shown.filter(({ id }) => settledIds.has(id))

      return shown.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">No Conversations yet.</p>
      ) : (
        <nav aria-label="Conversations list" className="flex flex-col gap-4">
          {groupConversations(going).map(({ machine, conversations: onMachine }) => (
            <section key={machine} aria-label={groupNames[machine]} className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {groupNames[machine]}
              </h2>
              <ConversationRows conversations={onMachine} now={now} settled={false} />
            </section>
          ))}
          {settled.length > 0 && <SettledSection conversations={settled} now={now} />}
        </nav>
      )
    })
    .render()
}

function ConversationRows(props: {
  conversations: ReadonlyArray<Conversation>
  now: Date
  settled: boolean
}) {
  return (
    <ul className="flex flex-col gap-0.5">
      {props.conversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          now={props.now}
          settled={props.settled}
        />
      ))}
    </ul>
  )
}

function SettledSection(props: { conversations: ReadonlyArray<Conversation>; now: Date }) {
  const [open, setOpen] = useAtom(settledOpenAtom)
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  const openId = useParams({ strict: false }).conversationId
  const [confirming, setConfirming] = useState(false)
  const [removing, setRemoving] = useState(false)

  const removeAll = async () => {
    setConfirming(false)
    setRemoving(true)

    await removeSettledConversations(registry, props.conversations, ({ id }) => {
      if (id === openId) void navigate({ to: "/conversations" })
    })

    setRemoving(false)
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      render={<section />}
      aria-label="Settled"
      className="flex flex-col gap-1"
    >
      <div className="group/settled flex items-center pr-1">
        <h2 className="min-w-0 flex-1">
          <CollapsibleTrigger className="group/trigger flex w-full items-center gap-1 rounded-sm px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
            Settled
            <span className="tabular-nums">{props.conversations.length}</span>
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
            aria-label="Remove Settled Conversations"
            disabled={removing}
            onClick={() => setConfirming(true)}
            className="opacity-0 group-hover/settled:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 aria-hidden />
          </Button>
        </TooltipHint>
      </div>
      <CollapsibleContent>
        <ConversationRows conversations={props.conversations} now={props.now} settled />
      </CollapsibleContent>
      <ConfirmationDialog
        open={confirming}
        title={
          props.conversations.length === 1
            ? "Remove 1 Settled Conversation?"
            : `Remove ${props.conversations.length} Settled Conversations?`
        }
        description="Glass removes each one without uncommitted changes, deleting its worktree or Sandbox and its transcript. Branches and their commits stay. Any with uncommitted changes stay listed for you to check."
        confirmLabel="Remove Conversations"
        onConfirm={() => void removeAll()}
        onCancel={() => setConfirming(false)}
      />
    </Collapsible>
  )
}

const removalWarning = (conversation: Conversation, warning: "some" | "unchecked") => {
  const inSandbox = Predicate.isTagged(conversation.place, "sandbox")

  if (warning === "unchecked")
    return inSandbox
      ? "Glass couldn't reach its Sandbox to check for uncommitted changes. Removing it deletes the Sandbox and everything in it."
      : `Glass couldn't check its worktree for uncommitted changes. Removing it discards any. The branch ${conversation.name} and its commits stay.`

  return inSandbox
    ? "Its Sandbox has uncommitted changes, which removing it discards along with the Sandbox."
    : `Its worktree has uncommitted changes, which removing it discards. The branch ${conversation.name} and its commits stay.`
}

const rowAction = "opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"

function BringBackButton(props: { conversation: Conversation }) {
  const bringBack = useAtomSet(bringBackConversationAtom)

  return (
    <TooltipHint content="Bring back">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Bring back ${props.conversation.name}`}
        onClick={() => bringBack(props.conversation.id)}
        className={rowAction}
      >
        <Undo2 aria-hidden />
      </Button>
    </TooltipHint>
  )
}

function ConversationRow(props: { conversation: Conversation; now: Date; settled: boolean }) {
  const { conversation } = props
  const navigate = useNavigate()
  const open = useParams({ strict: false }).conversationId === conversation.id
  const registry = useContext(RegistryContext)
  const warnings = useAtomValue(removalWarningsAtom(conversation.id))
  const checkWarnings = useAtomSet(removalWarningsAtom(conversation.id), { mode: "promiseExit" })

  const [confirming, setConfirming] = useState<"some" | "unchecked" | null>(null)

  const problem = settledProblem(warnings)
  const repositoryId = useId()
  const markerId = useId()

  const { sandbox } = conversation
  const sandboxText = sandbox === null ? null : sandboxLine(sandbox)
  const originId = useId()
  const harnessId = useId()
  const pullRequestId = useId()
  const pullRequest = useConversationPullRequest(conversation.id)

  const needsYou = useAtomValue(conversationsNeedingYouAtom).get(conversation.id)

  const working = Option.getOrElse(
    AsyncResult.value(useAtomValue(workingConversationsAtom)),
    () => noConversations,
  ).has(conversation.id)

  const showsWorking = needsYou === undefined && working

  const marker = needsYou !== undefined ? markerOf(needsYou) : showsWorking ? workingMarker : null

  const removeNow = () => {
    setConfirming(null)

    if (open) void navigate({ to: "/conversations" })

    void removeConversation(registry, conversation)
  }

  const start = async () => {
    const exit = await checkWarnings()

    if (Exit.isFailure(exit)) return

    const { uncommittedChanges } = exit.value

    if (uncommittedChanges === "none") removeNow()
    else setConfirming(uncommittedChanges)
  }

  return (
    <li className="group/row relative">
      <Link
        to="/conversations/$conversationId"
        params={{ conversationId: conversation.id }}
        aria-label={conversation.name}
        aria-describedby={[
          repositoryId,
          ...(marker === null ? [] : [markerId]),
          originId,
          ...(pullRequest === undefined ? [] : [pullRequestId]),
          harnessId,
        ].join(" ")}
        className={cn(
          conversationLink,
          sandbox !== null && isOutOfReach(sandbox.reach) && "opacity-60",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <FolderGit2 aria-hidden className="size-3.5 shrink-0" />
          <span id={repositoryId} className="min-w-0 flex-1 truncate">
            {repositoryKey(conversation.repository)}
          </span>
          {marker === null ? (
            <span className="shrink-0 tabular-nums">
              {ago(DateTime.toDateUtc(conversation.createdAt), props.now)}
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
        <span
          className={cn("truncate text-sm font-semibold", showsWorking && "text-muted-foreground")}
        >
          {conversation.name}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {sandboxText === null ? (
            <>
              <GitBranch aria-hidden className="size-3.5 shrink-0" />
              <span id={originId} className="min-w-0 flex-1 truncate">
                from {conversation.baseBranch}
              </span>
            </>
          ) : (
            <span
              id={originId}
              className={cn(
                "min-w-0 flex-1 truncate",
                readOnlyExplanation(sandbox?.reach) !== null && "text-destructive",
              )}
            >
              {sandboxText}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1.5 group-hover/row:opacity-0 group-has-[button:focus-visible]/row:opacity-0">
            {pullRequest !== undefined && (
              <ConversationPullRequestBadge id={pullRequestId} pullRequest={pullRequest} />
            )}
            <AgentHarnessIcon harness={conversation.harness} className="size-3" />
            <span id={harnessId} className="sr-only">
              {harnessNames[conversation.harness]}
            </span>
          </span>
        </span>
      </Link>
      <div className="absolute right-1 bottom-1 flex gap-0.5">
        {props.settled && <BringBackButton conversation={conversation} />}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Remove ${conversation.name}`}
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
        title={`Remove ${conversation.name}?`}
        description={confirming === null ? "" : removalWarning(conversation, confirming)}
        confirmLabel="Remove Conversation"
        onConfirm={removeNow}
        onCancel={() => setConfirming(null)}
      />
    </li>
  )
}

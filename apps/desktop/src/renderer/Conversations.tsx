import {
  RegistryContext,
  useAtom,
  useAtomRefresh,
  useAtomSet,
  useAtomValue,
} from "@effect/atom-react"
import {
  type Conversation,
  isGone,
  readOnlyExplanation,
  isOutOfReach,
  type PlaceTag,
  repositoryKey,
  type SandboxStatus,
} from "@glass/contracts"
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router"
import { DateTime, Exit, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { FolderGit2, PanelLeftClose, PanelLeftOpen, SquarePen, Trash2 } from "lucide-react"
import { cn } from "cn"
import { useContext, useId, useState } from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { TooltipHint } from "@/components/ui/tooltip"
import {
  conversationsAtom,
  conversationsPanelOpenAtom,
  groupConversations,
  placeNames,
  removalWarningsAtom,
  removeConversation,
  waitingConversationsAtom,
} from "./conversationsArea"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { settledProblem, streamProblem } from "./problems"
import { ProblemAlert } from "./ProblemAlert"
import { shortcutLabel } from "./shortcutLabel"
import { useShortcuts } from "./useShortcuts"

const groupNames: Record<PlaceTag, string> = { ...placeNames, sandbox: "Sandboxes" }

const noneWaiting: ReadonlySet<string> = new Set()

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
  "flex flex-col gap-0.5 rounded-md py-1.5 pr-8 pl-2 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent"

const panelId = "conversations-panel"

const panelToggleId = "conversations-panel-toggle"

export function ConversationsLayout() {
  const [panelOpen, setPanelOpen] = useAtom(conversationsPanelOpenAtom)
  const navigate = useNavigate()

  useShortcuts([
    {
      key: "n",
      mod: true,
      allowInEditable: true,
      run: () => void navigate({ to: "/conversations/new" }),
    },
    {
      key: "b",
      mod: true,
      allowInEditable: true,
      run: () => {
        if (panelOpen && document.getElementById(panelId)?.contains(document.activeElement))
          document.getElementById(panelToggleId)?.focus()

        setPanelOpen((open) => !open)
      },
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

  return AsyncResult.builder(conversations)
    .onInitial(() => (
      <output className="px-2 text-sm text-muted-foreground">Loading Conversations…</output>
    ))
    .onFailure((cause) => (
      <ProblemAlert problem={streamProblem(cause)} action={{ label: "Retry", run: retry }} />
    ))
    .onSuccess((list) => {
      const shown = list.filter((conversation) => !conversation.forReview)

      return shown.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">No Conversations yet.</p>
      ) : (
        <nav aria-label="Conversations list" className="flex flex-col gap-4">
          {groupConversations(shown).map(({ machine, conversations: onMachine }) => (
            <section key={machine} aria-label={groupNames[machine]} className="flex flex-col gap-1">
              <h2 className="px-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {groupNames[machine]}
              </h2>
              <ul className="flex flex-col gap-0.5">
                {onMachine.map((conversation) => (
                  <ConversationRow key={conversation.id} conversation={conversation} />
                ))}
              </ul>
            </section>
          ))}
        </nav>
      )
    })
    .render()
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

function ConversationRow(props: { conversation: Conversation }) {
  const { conversation } = props
  const navigate = useNavigate()
  const open = useParams({ strict: false }).conversationId === conversation.id
  const registry = useContext(RegistryContext)
  const warnings = useAtomValue(removalWarningsAtom(conversation.id))
  const checkWarnings = useAtomSet(removalWarningsAtom(conversation.id), { mode: "promiseExit" })

  const [confirming, setConfirming] = useState<"some" | "unchecked" | null>(null)

  const problem = settledProblem(warnings)
  const repositoryId = useId()
  const waitingId = useId()

  const { sandbox } = conversation
  const sandboxText = sandbox === null ? null : sandboxLine(sandbox)
  const sandboxId = useId()

  const waiting = Option.getOrElse(
    AsyncResult.value(useAtomValue(waitingConversationsAtom)),
    () => noneWaiting,
  ).has(conversation.id)

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
          ...(waiting ? [waitingId] : []),
          ...(sandboxText === null ? [] : [sandboxId]),
        ].join(" ")}
        className={cn(
          conversationLink,
          sandbox !== null && isOutOfReach(sandbox.reach) && "opacity-60",
        )}
      >
        <span
          id={repositoryId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <FolderGit2 aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{repositoryKey(conversation.repository)}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{conversation.name}</span>
          {waiting && (
            <span
              id={waitingId}
              className="flex shrink-0 items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
            >
              <span aria-hidden className="size-1.5 rounded-full bg-current" />
              Waiting on you
            </span>
          )}
        </span>
        {sandboxText !== null && (
          <span
            id={sandboxId}
            className={cn(
              "truncate text-xs text-muted-foreground",
              readOnlyExplanation(sandbox?.reach) !== null && "text-destructive",
            )}
          >
            {sandboxText}
          </span>
        )}
      </Link>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${conversation.name}`}
        disabled={warnings.waiting}
        onClick={() => void start()}
        className="absolute top-1/2 right-1 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 aria-hidden />
      </Button>
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

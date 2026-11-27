import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  Link,
  type LinkOptions,
  Outlet,
  useBlocker,
  useMatch,
  useNavigate,
} from "@tanstack/react-router"
import { cn } from "cn"
import {
  LayoutDashboard,
  GitPullRequest,
  History,
  Inbox,
  ListOrdered,
  ListTodo,
  LoaderCircle,
  type LucideIcon,
  MessagesSquare,
  Settings,
  Sparkles,
  SquarePen,
} from "lucide-react"
import { type ComponentType, type ReactNode, useContext, useEffect, useId, useState } from "react"
import { TooltipHint } from "@/components/ui/tooltip"
import { backendReachableAtom } from "./backend"
import { type Action, useActions } from "./actions"
import { CommandMenu } from "./CommandMenu"
import { useStartThread } from "./threadsArea"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { ConnectionMenu } from "./ConnectionMenu"
import { globalChatOpenAtom, globalUnseenAtom } from "./globalChat"
import { HistoryNav } from "./HistoryNav"
import { InboxBadge } from "./InboxCount"
import { inboxCountAtom, threadsInInboxAtom } from "./inboxArea"
import {
  confirmLeave,
  discardPromptAtom,
  leavesPullRequest,
  listSearchAtom,
  reviewsLinkAtom,
} from "./reviewsArea"
import { RailResourceUsage, railResourceUsageAtom } from "./ResourceUsage"
import { ShellPanelSlot, ShellTitleSlot, useShellSlot } from "./shellSlots"
import { ShortcutsDialog } from "./ShortcutsDialog"

const railLink =
  "relative flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-black/[0.07] aria-[current=page]:text-foreground aria-pressed:bg-black/[0.07] aria-pressed:text-foreground dark:hover:bg-white/5 dark:aria-[current=page]:bg-white/10 dark:aria-pressed:bg-white/10"

type AreaLabel = "Dashboard" | "Inbox" | "Reviews" | "To-dos" | "Threads" | "Activity" | "Settings"

interface Area {
  readonly label: AreaLabel
  readonly icon: LucideIcon
  readonly link: LinkOptions
}

function useAreas(): ReadonlyArray<Area> {
  const reviewsLink = useAtomValue(reviewsLinkAtom)

  return [
    { label: "Dashboard", icon: LayoutDashboard, link: { to: "/dashboard" } },
    { label: "Inbox", icon: Inbox, link: { to: "/inbox" } },
    { label: "Reviews", icon: GitPullRequest, link: reviewsLink },
    { label: "To-dos", icon: ListTodo, link: { to: "/to-dos" } },
    { label: "Threads", icon: Sparkles, link: { to: "/threads" } },
    { label: "Activity", icon: History, link: { to: "/activity" } },
    { label: "Settings", icon: Settings, link: { to: "/settings" } },
  ]
}

function GlassMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="M8 13.5 13.5 8" />
      <path d="M10.5 16 16 10.5" opacity={0.5} />
    </svg>
  )
}

export function AppShell() {
  const registry = useContext(RegistryContext)
  const areas = useAreas()
  const navigate = useNavigate()
  const startThread = useStartThread()
  const [chatting, setChatting] = useAtom(globalChatOpenAtom)
  const [GlobalChatDialog, setGlobalChatDialog] = useState<ComponentType>()

  const current = useMatch({ from: "/reviews/$owner/$repo/$number", shouldThrow: false })?.params

  useEffect(() => {
    const load = () =>
      void import("./GlobalChatDialog").then((module) =>
        setGlobalChatDialog(() => module.GlobalChatDialog),
      )

    if (chatting) load()

    const idle = requestIdleCallback(load)

    return () => cancelIdleCallback(idle)
  }, [chatting])

  const toggleChatting = () => setChatting((open) => !open)

  const viewQueue = () =>
    void navigate({ to: "/reviews", search: { ...registry.get(listSearchAtom), list: "queue" } })

  useActions([
    ...areas.map(({ label, icon, link }, index): Action => ({
      id: `go-to-${label}`,
      title: label,
      group: "Go to",
      icon,
      shortcut: { key: `${index + 1}`, mod: true, allowInEditable: true },
      run: () => void navigate(link),
    })),
    {
      id: "go-to-queue",
      title: "Queue",
      group: "Go to",
      icon: ListOrdered,
      keywords: ["reviews"],
      run: viewQueue,
    },
    {
      id: "new-thread",
      title: "New Thread",
      group: "Thread",
      icon: SquarePen,
      shortcut: { key: "n", mod: true, allowInEditable: true },
      run: () => void navigate({ to: "/threads/new" }),
    },
    {
      id: "global-chat",
      title: chatting ? "Close the Global chat" : "Open the Global chat",
      group: "Glass",
      icon: MessagesSquare,
      shortcut: { key: "j", mod: true, allowInEditable: true, allowInDialog: true },
      run: toggleChatting,
    },
  ])

  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async ({ next }) =>
      leavesPullRequest(registry, next) && !(await confirmLeave(registry)),
  })

  return (
    <div className="relative flex h-screen flex-col overflow-clip">
      <Frame
        rail={<AreaRail areas={areas} chatting={chatting} onToggleChatting={toggleChatting} />}
      />
      {GlobalChatDialog && <GlobalChatDialog />}
      <CommandMenu
        current={current}
        onOpen={(ref) => void navigate({ to: "/reviews/$owner/$repo/$number", params: ref })}
        onOpenThread={(threadId) =>
          void navigate({ to: "/threads/$threadId", params: { threadId } })
        }
        onStartThread={startThread}
        onViewQueue={viewQueue}
      />
      <DiscardDialog />
      <ShortcutsDialog />
    </div>
  )
}

function Frame(props: { rail: ReactNode }) {
  const showsResourceUsage = useAtomValue(railResourceUsageAtom)

  const [panelSlot, attachPanelSlot] = useShellSlot()
  const [titleSlot, attachTitleSlot] = useShellSlot()

  return (
    <div className="flex min-h-0 flex-1 bg-chrome">
      <aside className="flex w-14 shrink-0 flex-col items-center gap-2 pb-3">
        <div className="title-strip title-strip-below-controls flex w-full shrink-0 items-center justify-center">
          <TooltipHint content="Glass" side="right">
            <span className="flex size-9 items-center justify-center [app-region:no-drag]">
              <GlassMark />
              <span className="sr-only">Glass</span>
            </span>
          </TooltipHint>
        </div>
        {props.rail}
        {showsResourceUsage && <RailResourceUsage />}
      </aside>
      <div ref={attachPanelSlot} className="contents" />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="title-strip title-strip-clear-controls flex shrink-0 items-center pl-[max(0px,calc(env(titlebar-area-x,0px)-3.5rem))]">
          <HistoryNav />
          <div ref={attachTitleSlot} className="contents" />
        </div>
        <div className="mr-2 mb-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm">
          <ShellPanelSlot value={panelSlot}>
            <ShellTitleSlot value={titleSlot}>
              <Reconnecting />
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <Outlet />
              </div>
            </ShellTitleSlot>
          </ShellPanelSlot>
        </div>
      </div>
    </div>
  )
}

function AreaRail(props: {
  areas: ReadonlyArray<Area>
  chatting: boolean
  onToggleChatting: () => void
}) {
  const inboxBadgeId = useId()
  const inboxWaiting = Option.getOrElse(useAtomValue(inboxCountAtom), () => 0)
  const threadsInInboxId = useId()
  const threadsInInbox = useAtomValue(threadsInInboxAtom).size > 0
  const unseen = Option.getOrNull(AsyncResult.value(useAtomValue(globalUnseenAtom)))
  const unread = unseen !== null && !props.chatting

  return (
    <>
      <nav aria-label="App areas" className="flex w-full flex-1 flex-col items-center gap-2">
        {props.areas.map(({ label, icon: Icon, link }, index) => (
          <TooltipHint key={label} content={label} side="right">
            <Link
              {...link}
              activeOptions={{ includeSearch: false }}
              aria-label={label}
              aria-describedby={
                label === "Inbox" && inboxWaiting > 0
                  ? inboxBadgeId
                  : label === "Threads" && threadsInInbox
                    ? threadsInInboxId
                    : undefined
              }
              aria-keyshortcuts={`Meta+${index + 1} Control+${index + 1}`}
              className={cn(railLink, label === "Activity" && "mt-auto")}
            >
              <Icon className="size-4" aria-hidden />
              {label === "Inbox" && inboxWaiting > 0 && (
                <InboxBadge id={inboxBadgeId} count={inboxWaiting} />
              )}
              {label === "Threads" && threadsInInbox && (
                <span
                  id={threadsInInboxId}
                  className="absolute top-1 right-1 size-2 rounded-full bg-primary"
                >
                  <span className="sr-only">In your Inbox</span>
                </span>
              )}
            </Link>
          </TooltipHint>
        ))}
      </nav>
      <TooltipHint content="Global chat" side="right">
        <button
          type="button"
          aria-label="Global chat"
          aria-pressed={props.chatting}
          aria-keyshortcuts="Meta+J Control+J"
          className={railLink}
          onClick={props.onToggleChatting}
        >
          <MessagesSquare className="size-4" aria-hidden />
          {unread && (
            <span className="absolute top-1 right-1 size-2 rounded-full bg-primary">
              <span className="sr-only">Unread reply</span>
            </span>
          )}
        </button>
      </TooltipHint>
      <ConnectionMenu />
    </>
  )
}

function Reconnecting() {
  if (useAtomValue(backendReachableAtom)) return null

  return (
    <output className="flex shrink-0 items-center gap-2 border-b bg-muted/40 px-6 py-2 text-sm text-foreground opacity-100 transition-opacity duration-160 ease-out starting:opacity-75 motion-reduce:duration-100 motion-reduce:starting:opacity-95">
      <LoaderCircle className="size-4 animate-spin" aria-hidden />
      Reconnecting to Glass's backend…
    </output>
  )
}

function DiscardDialog() {
  const prompt = useAtomValue(discardPromptAtom)

  return (
    <ConfirmationDialog
      open={prompt !== null}
      title="Discard unpublished feedback?"
      description={prompt?.description ?? ""}
      confirmLabel="Discard feedback"
      onConfirm={() => prompt?.answer(true)}
      onCancel={() => prompt?.answer(false)}
    />
  )
}

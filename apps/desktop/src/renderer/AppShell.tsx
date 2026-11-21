import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react"
import type { Layout } from "@glass/contracts"
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
import { ConnectionAvatar } from "./ConnectionAvatar"
import { globalChatOpenAtom, globalUnseenAtom } from "./globalChat"
import { HistoryNav } from "./HistoryNav"
import { NeedsYouBadge } from "./NeedsYouCount"
import { threadsNeedingYouAtom, needsYouCount as countOf, watchedNeedsYouAtom } from "./needsYou"
import {
  confirmLeave,
  discardPromptAtom,
  leavesPullRequest,
  listSearchAtom,
  reviewsLinkAtom,
} from "./reviewsArea"
import { ResourceUsage } from "./ResourceUsage"
import { ShellPanelSlot } from "./shellPanelSlot"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { AccountMenu, PrototypeSwitcher, useStatusVariant } from "./StatusBarPrototype"
import { useAppearance } from "./theme"

const classicRailLink =
  "relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground aria-[current=page]:before:absolute aria-[current=page]:before:-left-2 aria-[current=page]:before:h-3 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-foreground aria-pressed:bg-accent aria-pressed:text-accent-foreground"

const insetRailLink =
  "relative flex size-9 items-center justify-center rounded-lg text-muted-foreground outline-none hover:bg-black/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-black/[0.07] aria-[current=page]:text-foreground aria-pressed:bg-black/[0.07] aria-pressed:text-foreground dark:hover:bg-white/5 dark:aria-[current=page]:bg-white/10 dark:aria-pressed:bg-white/10"

type AreaLabel = "Dashboard" | "Inbox" | "Reviews" | "To-dos" | "Threads" | "Activity" | "Settings"

interface RailStyle {
  readonly link: string
  readonly bottomFrom: AreaLabel
}

const railStyles = {
  classic: { link: classicRailLink, bottomFrom: "Settings" },
  inset: { link: insetRailLink, bottomFrom: "Activity" },
} satisfies Record<Layout, RailStyle>

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
  const { layout } = useAppearance()
  const variant = useStatusVariant()
  const v = layout === "inset" ? variant : "current"

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

  const rail = (
    <AreaRail
      areas={areas}
      chatting={chatting}
      onToggleChatting={toggleChatting}
      style={railStyles[layout]}
      variant={v}
    />
  )

  const page = (
    <>
      <Reconnecting />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
      {v === "current" ? (
        <footer className="flex h-7 shrink-0 items-center justify-end gap-1 border-t bg-muted/20 px-3">
          <ShortcutsDialog />
          <ResourceUsage />
        </footer>
      ) : (
        (v === "A" || v === "D") && <ShortcutsDialog look="hidden" />
      )}
    </>
  )

  return (
    <div className="relative flex h-screen flex-col overflow-clip">
      {layout === "inset" ? (
        <InsetFrame rail={rail} variant={v}>
          {page}
        </InsetFrame>
      ) : (
        <ClassicFrame rail={rail}>{page}</ClassicFrame>
      )}
      {GlobalChatDialog && <GlobalChatDialog />}
      <CommandMenu
        current={current}
        onOpen={(ref) => void navigate({ to: "/reviews/$owner/$repo/$number", params: ref })}
        onOpenThread={(threadId) =>
          void navigate({ to: "/threads/$threadId", params: { threadId } })
        }
        onStartThread={startThread}
        onViewQueue={() =>
          void navigate({
            to: "/reviews",
            search: { ...registry.get(listSearchAtom), list: "queue" },
          })
        }
      />
      <DiscardDialog />
      {layout === "inset" && <PrototypeSwitcher />}
    </div>
  )
}

function ClassicFrame(props: { rail: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="title-strip flex shrink-0 items-center border-b pr-2 pl-[calc(env(titlebar-area-x,0px)+0.75rem)]">
        <HistoryNav />
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-12 shrink-0 flex-col items-center gap-4 border-r bg-muted/40 py-3">
          <TooltipHint content="Glass" side="right">
            <div className="flex h-8 items-center">
              <GlassMark />
              <span className="sr-only">Glass</span>
            </div>
          </TooltipHint>
          {props.rail}
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">{props.children}</div>
      </div>
    </>
  )
}

function InsetFrame(props: { rail: ReactNode; children: ReactNode; variant: string }) {
  const [panelSlot] = useState(() =>
    Object.assign(document.createElement("div"), { className: "contents" }),
  )

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
      </aside>
      <div
        ref={(node) => {
          if (node !== null && panelSlot.parentNode !== node) node.append(panelSlot)
        }}
        className="contents"
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="title-strip flex shrink-0 items-center pl-[max(0px,calc(env(titlebar-area-x,0px)-3.5rem))]">
          <HistoryNav />
          {props.variant === "B" && (
            <div
              className="ml-auto flex items-center gap-1 [app-region:no-drag]"
              style={{
                marginRight:
                  "calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 0.5rem)",
              }}
            >
              <ShortcutsDialog look="icon" />
              <ResourceUsage look="pill" side="bottom" />
            </div>
          )}
        </div>
        <div
          className={cn(
            "mr-2 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border bg-background shadow-sm",
            props.variant !== "D" && "mb-2",
          )}
        >
          <ShellPanelSlot value={panelSlot}>{props.children}</ShellPanelSlot>
        </div>
        {props.variant === "D" && (
          <footer className="mr-2 flex h-6 shrink-0 items-center justify-end gap-1 opacity-80">
            <ResourceUsage />
          </footer>
        )}
      </div>
    </div>
  )
}

function AreaRail(props: {
  areas: ReadonlyArray<Area>
  chatting: boolean
  onToggleChatting: () => void
  style: RailStyle
  variant: string
}) {
  const needsYouBadgeId = useId()
  const needsYouCount = countOf(useAtomValue(watchedNeedsYouAtom))
  const threadsNeedYouId = useId()
  const threadsNeedYou = useAtomValue(threadsNeedingYouAtom).size > 0
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
                label === "Inbox" && Option.isSome(needsYouCount) && needsYouCount.value > 0
                  ? needsYouBadgeId
                  : label === "Threads" && threadsNeedYou
                    ? threadsNeedYouId
                    : undefined
              }
              aria-keyshortcuts={`Meta+${index + 1} Control+${index + 1}`}
              className={cn(props.style.link, label === props.style.bottomFrom && "mt-auto")}
            >
              <Icon className="size-4" aria-hidden />
              {label === "Inbox" && <NeedsYouBadge id={needsYouBadgeId} />}
              {label === "Threads" && threadsNeedYou && (
                <span
                  id={threadsNeedYouId}
                  className="absolute top-1 right-1 size-2 rounded-full bg-primary"
                >
                  <span className="sr-only">Needs you</span>
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
          className={props.style.link}
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
      {props.variant === "C" && (
        <div className="flex flex-col items-center gap-1 border-t border-black/5 pt-2 dark:border-white/10">
          <ShortcutsDialog look="icon" />
          <ResourceUsage look="meter" side="right" />
        </div>
      )}
      {props.variant === "A" ? <AccountMenu /> : <ConnectionAvatar />}
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

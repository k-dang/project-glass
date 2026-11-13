import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { Link, type LinkOptions, Outlet, useBlocker, useNavigate } from "@tanstack/react-router"
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
} from "lucide-react"
import { useContext, useId } from "react"
import { TooltipHint } from "@/components/ui/tooltip"
import { backendReachableAtom } from "./backend"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { globalConversationOpenAtom, globalUnseenAtom } from "./globalConversation"
import { GlobalConversationDialog } from "./GlobalConversationDialog"
import { NeedsYouBadge } from "./NeedsYouCount"
import { needsYouCount as countOf, watchedNeedsYouAtom } from "./needsYou"
import { confirmLeave, discardPromptAtom, leavesPullRequest, reviewsLinkAtom } from "./reviewsArea"
import { ConnectionAvatar } from "./Settings"
import { ResourceUsage } from "./ResourceUsage"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { useShortcuts } from "./useShortcuts"

const railLink =
  "relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground aria-[current=page]:before:absolute aria-[current=page]:before:-left-2 aria-[current=page]:before:h-3 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-foreground"

interface Area {
  readonly label: string
  readonly icon: LucideIcon
  readonly link: LinkOptions
}

// Rail order is shortcut order: Mod+1 opens the first area.
function useAreas(): ReadonlyArray<Area> {
  const reviewsLink = useAtomValue(reviewsLinkAtom)

  return [
    { label: "Dashboard", icon: LayoutDashboard, link: { to: "/dashboard" } },
    { label: "Inbox", icon: Inbox, link: { to: "/inbox" } },
    { label: "Reviews", icon: GitPullRequest, link: reviewsLink },
    { label: "To-dos", icon: ListTodo, link: { to: "/to-dos" } },
    { label: "Agents", icon: Sparkles, link: { to: "/agents" } },
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
  const [conversing, setConversing] = useAtom(globalConversationOpenAtom)
  const needsYouBadgeId = useId()
  const needsYouCount = countOf(useAtomValue(watchedNeedsYouAtom))
  const unseen = Option.getOrNull(AsyncResult.value(useAtomValue(globalUnseenAtom)))
  const unread = unseen !== null && !conversing

  useShortcuts([
    ...areas.map(({ link }, index) => ({
      key: `${index + 1}`,
      mod: true,
      allowInEditable: true,
      run: () => void navigate(link),
    })),
    {
      key: "j",
      mod: true,
      allowInEditable: true,
      allowInDialog: true,
      run: () => setConversing((open) => !open),
    },
  ])

  useBlocker({
    enableBeforeUnload: false,
    shouldBlockFn: async ({ next }) =>
      leavesPullRequest(registry, next) && !(await confirmLeave(registry)),
  })

  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="flex w-12 shrink-0 flex-col">
        <div className="title-strip shrink-0 border-b" />
        <div className="flex flex-1 flex-col items-center gap-4 border-r bg-muted/40 py-3">
          <TooltipHint content="Glass" side="right">
            <div className="flex h-8 items-center">
              <GlassMark />
              <span className="sr-only">Glass</span>
            </div>
          </TooltipHint>
          <nav aria-label="App areas" className="flex w-full flex-1 flex-col items-center gap-2">
            {areas.map(({ label, icon: Icon, link }, index) => (
              <TooltipHint key={label} content={label} side="right">
                <Link
                  {...link}
                  activeOptions={{ includeSearch: false }}
                  aria-label={label}
                  aria-describedby={
                    label === "Inbox" && Option.isSome(needsYouCount) && needsYouCount.value > 0
                      ? needsYouBadgeId
                      : undefined
                  }
                  aria-keyshortcuts={`Meta+${index + 1} Control+${index + 1}`}
                  className={cn(railLink, label === "Settings" && "mt-auto")}
                >
                  <Icon className="size-4" aria-hidden />
                  {label === "Inbox" && <NeedsYouBadge id={needsYouBadgeId} />}
                </Link>
              </TooltipHint>
            ))}
          </nav>
          <TooltipHint content="Global conversation" side="right">
            <button
              type="button"
              aria-label="Global conversation"
              aria-pressed={conversing}
              aria-keyshortcuts="Meta+J Control+J"
              className={cn(railLink, "aria-pressed:bg-accent aria-pressed:text-accent-foreground")}
              onClick={() => setConversing((open) => !open)}
            >
              <MessagesSquare className="size-4" aria-hidden />
              {unread && (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-primary">
                  <span className="sr-only">Unread reply</span>
                </span>
              )}
            </button>
          </TooltipHint>
          <ConnectionAvatar />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="title-strip shrink-0 border-b" aria-hidden />
        <Reconnecting />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <footer className="flex h-7 shrink-0 items-center justify-end gap-1 border-t bg-muted/20 px-3">
          <ShortcutsDialog />
          <ResourceUsage />
        </footer>
      </div>
      <GlobalConversationDialog />
      <DiscardDialog />
    </div>
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

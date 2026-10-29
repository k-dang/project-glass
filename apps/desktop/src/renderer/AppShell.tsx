import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { Link, Outlet, useBlocker } from "@tanstack/react-router"
import { cn } from "cn"
import {
  LayoutDashboard,
  GitPullRequest,
  History,
  ListTodo,
  LoaderCircle,
  type LucideIcon,
  Settings,
  Sparkles,
} from "lucide-react"
import { useContext } from "react"
import { TooltipHint } from "@/components/ui/tooltip"
import { backendReachableAtom } from "./backend"
import { ConfirmationDialog } from "./ConfirmationDialog"
import { confirmLeave, discardPromptAtom, leavesPullRequest, reviewsLinkAtom } from "./reviewsArea"
import { ConnectionAvatar } from "./Settings"
import { ResourceUsage } from "./ResourceUsage"

const railLink =
  "relative flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-accent-foreground aria-[current=page]:before:absolute aria-[current=page]:before:-left-2 aria-[current=page]:before:h-3 aria-[current=page]:before:w-0.5 aria-[current=page]:before:rounded-full aria-[current=page]:before:bg-foreground"

const areas: ReadonlyArray<{
  readonly to: "/to-dos" | "/activity" | "/agents" | "/settings"
  readonly label: string
  readonly icon: LucideIcon
}> = [
  { to: "/to-dos", label: "To-dos", icon: ListTodo },
  { to: "/agents", label: "Agents", icon: Sparkles },
  { to: "/activity", label: "Activity", icon: History },
  { to: "/settings", label: "Settings", icon: Settings },
]

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
  const reviewsLink = useAtomValue(reviewsLinkAtom)

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
            <TooltipHint content="Dashboard" side="right">
              <Link to="/dashboard" aria-label="Dashboard" className={railLink}>
                <LayoutDashboard className="size-4" aria-hidden />
              </Link>
            </TooltipHint>
            <TooltipHint content="Reviews" side="right">
              <Link
                {...reviewsLink}
                activeOptions={{ includeSearch: false }}
                aria-label="Reviews"
                className={railLink}
              >
                <GitPullRequest className="size-4" aria-hidden />
              </Link>
            </TooltipHint>
            {areas.map(({ to, label, icon: Icon }) => (
              <TooltipHint key={to} content={label} side="right">
                <Link
                  to={to}
                  aria-label={label}
                  className={cn(railLink, to === "/settings" && "mt-auto")}
                >
                  <Icon className="size-4" aria-hidden />
                </Link>
              </TooltipHint>
            ))}
          </nav>
          <ConnectionAvatar />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="title-strip shrink-0 border-b" aria-hidden />
        <Reconnecting />
        <Outlet />
        <ResourceUsage />
      </div>
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

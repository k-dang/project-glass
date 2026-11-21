// PROTOTYPE, throwaway. Where do Keyboard shortcuts and resource usage go in the Inset layout?
// Variants live in AppShell, picked from the floating switcher at the bottom of the window.
import { AsyncResult } from "effect/reactivity"
import { ChevronLeft, ChevronRight, Keyboard, LogOut } from "lucide-react"
import { useEffect, useSyncExternalStore } from "react"
import { Avatar, AvatarBadge, AvatarFallback } from "@/components/ui/avatar"
import { Kbd } from "@/components/ui/kbd"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useConnection } from "./connection"
import { describeSource } from "./problems"
import { ResourceUsage } from "./ResourceUsage"

export const variants = [
  { key: "current", name: "Today: footer in the card" },
  { key: "A", name: "Account menu on the avatar" },
  { key: "B", name: "Title strip, top right" },
  { key: "C", name: "Rail cluster above the avatar" },
  { key: "D", name: "Gutter under the card" },
] as const

export type StatusVariant = (typeof variants)[number]["key"]

const storageKey = "prototype:status-bar-variant"
const listeners = new Set<() => void>()

const read = (): StatusVariant => {
  const stored = localStorage.getItem(storageKey)

  return variants.find((variant) => variant.key === stored)?.key ?? "A"
}

const write = (next: StatusVariant) => {
  localStorage.setItem(storageKey, next)
  for (const listener of listeners) listener()
}

export function useStatusVariant() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    },
    read,
  )
}

const step = (by: number) => {
  const index = variants.findIndex((variant) => variant.key === read())
  write(variants[(index + by + variants.length) % variants.length]!.key)
}

export function PrototypeSwitcher() {
  const current = useStatusVariant()
  const variant = variants.find((candidate) => candidate.key === current)!

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return
      if (event.key === "ArrowLeft") step(-1)
      else if (event.key === "ArrowRight") step(1)
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [])

  return (
    <div className="fixed bottom-10 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full bg-fuchsia-600 p-1 text-xs font-medium text-white shadow-lg">
      <button
        type="button"
        aria-label="Previous variant"
        className="rounded-full p-1 hover:bg-white/20"
        onClick={() => step(-1)}
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="px-2">
        PROTOTYPE {variant.key} · {variant.name}
      </span>
      <button
        type="button"
        aria-label="Next variant"
        className="rounded-full p-1 hover:bg-white/20"
        onClick={() => step(1)}
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

const openShortcuts = () =>
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", shiftKey: true, bubbles: true }))

export function AccountMenu() {
  const { result } = useConnection()

  const identity = AsyncResult.builder(result)
    .onInitialOrWaiting(() => ({
      login: "Connecting…",
      source: "",
      initial: "…",
      dot: "animate-pulse bg-muted-foreground",
    }))
    .onFailure(() => ({
      login: "Not connected",
      source: "GitHub",
      initial: "!",
      dot: "bg-destructive",
    }))
    .onSuccess((connection) => ({
      login: `@${connection.login}`,
      source: `via ${describeSource(connection.tokenSource)}`,
      initial: connection.login.slice(0, 1).toUpperCase(),
      dot: "bg-emerald-500",
    }))
    .render()

  return (
    <Popover>
      <PopoverTrigger
        aria-label="Account and app status"
        className="rounded-full focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Avatar className="size-7">
          <AvatarFallback className="bg-accent text-xs">{identity.initial}</AvatarFallback>
          <AvatarBadge className={`-right-0.5 -bottom-0.5 ${identity.dot}`} aria-hidden />
        </Avatar>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" sideOffset={10} className="w-64 gap-1 p-1.5">
        <div className="flex items-center gap-2.5 px-2 py-2">
          <Avatar className="size-8">
            <AvatarFallback className="bg-accent text-xs">{identity.initial}</AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{identity.login}</p>
            <p className="truncate text-xs text-muted-foreground">{identity.source}</p>
          </div>
        </div>
        <div className="-mx-1.5 my-1 h-px bg-border" />
        <button
          type="button"
          onClick={openShortcuts}
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
        >
          <Keyboard className="size-4 text-muted-foreground" aria-hidden />
          Keyboard shortcuts
          <Kbd className="ml-auto">?</Kbd>
        </button>
        <ResourceUsage look="row" side="right" />
        <div className="-mx-1.5 my-1 h-px bg-border" />
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-accent"
        >
          <LogOut className="size-4" aria-hidden />
          GitHub connection…
        </button>
      </PopoverContent>
    </Popover>
  )
}

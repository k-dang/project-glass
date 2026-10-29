import { ArrowUpRight, Copy, Keyboard, type LucideIcon, Route, Search, XIcon } from "lucide-react"
import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { useReviewShortcuts } from "./useReviewShortcuts"

interface ShortcutGroup {
  readonly title: string
  readonly icon: LucideIcon
  readonly note: string
  readonly shortcuts: ReadonlyArray<{
    readonly label: string
    readonly keys: ReadonlyArray<string>
  }>
}

const groups: ReadonlyArray<ShortcutGroup> = [
  {
    title: "Workspace",
    icon: ArrowUpRight,
    note: "Queue commands work when this PR is in the Queue. Next PR needs another queued PR.",
    shortcuts: [
      { label: "Back to PRs", keys: ["Escape"] },
      { label: "Open another PR", keys: ["Mod", "L"] },
      { label: "Open Copy menu", keys: ["C"] },
      { label: "Remove from Queue & advance", keys: ["Mod", "]"] },
      { label: "Next queued PR", keys: ["Mod", "Shift", "]"] },
      { label: "Show keyboard shortcuts", keys: ["?"] },
    ],
  },
  {
    title: "Copy",
    icon: Copy,
    note: "Press C, then the next key. Escape closes the menu.",
    shortcuts: [
      { label: "PR link", keys: ["C", "then", "G"] },
      { label: "PR title", keys: ["C", "then", "T"] },
      { label: "PR branch name", keys: ["C", "then", "B"] },
      { label: "CLI checkout command", keys: ["C", "then", "C"] },
    ],
  },
  {
    title: "Tour",
    icon: Route,
    note: "In Changes, when it shows Tour order.",
    shortcuts: [
      { label: "Next Chapter", keys: ["]"] },
      { label: "Previous Chapter", keys: ["["] },
    ],
  },
]

export function ReviewShortcutsDialog() {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const search = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const modifier = navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl"
  const term = query.trim().toLowerCase()

  const matches = groups.flatMap((group) => {
    const shortcuts = group.shortcuts.filter((shortcut) =>
      `${group.title} ${shortcut.label} ${shortcut.keys.join(" ").replace("Mod", "Ctrl Control Cmd Command ⌘")}`
        .toLowerCase()
        .includes(term),
    )

    return shortcuts.length === 0 ? [] : [{ ...group, shortcuts }]
  })

  const count = matches.reduce((sum, group) => sum + group.shortcuts.length, 0)

  const keyLabel = (key: string) => {
    if (key === "Mod") return modifier

    return key === "Escape" ? "Esc" : key
  }

  const show = () => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setQuery("")
    setOpen(true)
  }

  useReviewShortcuts([{ key: "?", allowShift: true, run: show }])

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (
          details.reason === "escape-key" &&
          (details.event.defaultPrevented || details.event.isComposing || details.event.repeat)
        ) {
          details.cancel()

          return
        }

        if (next) show()
        else setOpen(false)
      }}
    >
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="gap-2 text-xs text-muted-foreground"
            aria-keyshortcuts="?"
            title="Keyboard shortcuts (?)"
          />
        }
      >
        <Keyboard aria-hidden />
        Keyboard shortcuts
        <Kbd>?</Kbd>
      </DialogTrigger>
      <DialogContent
        instant
        initialFocus={search}
        finalFocus={() => opener.current}
        showCloseButton={false}
        className="flex max-h-[min(48rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
      >
        <header className="flex items-start justify-between gap-4 px-5 pt-5 pb-4">
          <div>
            <DialogTitle className="text-sm">Keyboard shortcuts</DialogTitle>
            <DialogDescription className="mt-1.5 text-xs">PR workspace</DialogDescription>
          </div>
          <DialogClose
            render={<Button variant="ghost" size="icon-sm" aria-label="Close shortcuts" />}
          >
            <XIcon aria-hidden />
          </DialogClose>
        </header>
        <div className="relative mx-5 mb-4">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={search}
            aria-label="Search keyboard shortcuts"
            placeholder="Search shortcuts…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-9 pl-9 text-sm"
          />
        </div>
        <section
          className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          aria-label="Shortcut reference"
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard scrolling.
          tabIndex={0}
        >
          {matches.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-sm font-medium">No matching shortcuts</p>
              <p className="mt-1 text-xs text-muted-foreground">Try “copy”, “Tour”, or “Ctrl”.</p>
              <Button
                variant="link"
                size="sm"
                className="mt-2 text-xs"
                onClick={() => {
                  setQuery("")
                  search.current?.focus()
                }}
              >
                Clear search
              </Button>
            </div>
          ) : (
            <div className="grid gap-x-7 gap-y-6 sm:grid-cols-2">
              {matches.map((group) => (
                <section key={group.title} aria-label={group.title}>
                  <h3 className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <group.icon className="size-3.5" aria-hidden />
                    {group.title}
                  </h3>
                  <ul>
                    {group.shortcuts.map((shortcut) => (
                      <li
                        key={shortcut.label}
                        className="flex min-h-9 items-center justify-between gap-3 py-1 text-xs"
                      >
                        <span>{shortcut.label}</span>
                        <span className="flex shrink-0 items-center gap-1">
                          {shortcut.keys.map((key, index) =>
                            key === "then" || key === "or" ? (
                              <span key={index} className="text-[10px] text-muted-foreground">
                                {key}
                              </span>
                            ) : (
                              <Kbd key={index} className="border border-border bg-muted/60">
                                {keyLabel(key)}
                              </Kbd>
                            ),
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    {group.note}
                  </p>
                </section>
              ))}
            </div>
          )}
        </section>
        <footer className="flex shrink-0 items-center justify-between gap-4 border-t bg-muted/30 px-5 py-3 text-[11px] text-muted-foreground">
          <span>Letter shortcuts pause while typing.</span>
          <span className="flex shrink-0 items-center gap-1.5">
            <Kbd>?</Kbd> Show help
          </span>
        </footer>
        <output className="sr-only">{count} shortcuts shown</output>
      </DialogContent>
    </Dialog>
  )
}

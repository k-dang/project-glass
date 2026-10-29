import { TooltipHint } from "@/components/ui/tooltip"
import { RegistryContext, useAtomValue } from "@effect/atom-react"
import { type PullRequestRef, referenceKey } from "@glass/contracts"
import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ListOrdered } from "lucide-react"
import { type ReactNode, useContext, useEffect, useEffectEvent } from "react"
import { Button } from "@/components/ui/button"
import { removeFromQueue, reviewedOutAtom, savedQueueAtom } from "./queue"
import { listSearchAtom, sameRef, targetAtom } from "./reviewsArea"

export function QueueBar(props: {
  current: PullRequestRef
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const registry = useContext(RegistryContext)
  const navigate = useNavigate()
  const entries = Option.getOrElse(AsyncResult.value(useAtomValue(savedQueueAtom)), () => [])
  const reviewedOut = useAtomValue(reviewedOutAtom)
  const key = referenceKey(props.current)
  const position = entries.findIndex((queued) => referenceKey(queued.pullRequest.ref) === key)
  const queued = position !== -1
  const next = queued && entries.length > 1 ? entries[(position + 1) % entries.length]! : null

  const removeThenNext = async () => {
    const current = props.current

    if (next !== null) {
      await navigate({ to: "/reviews/$owner/$repo/$number", params: next.pullRequest.ref })

      const target = registry.get(targetAtom)
      const stayedToKeepUnsavedWork = target !== null && sameRef(target, current)

      if (stayedToKeepUnsavedWork) return
    }

    await removeFromQueue(registry, current)
  }

  const onShortcut = useEffectEvent((event: KeyboardEvent) => {
    const typing =
      event.target instanceof Element &&
      event.target.closest("input, textarea, [contenteditable], [role=dialog]") !== null

    if (
      !queued ||
      typing ||
      (event.key !== "]" && !(event.shiftKey && event.key === "}")) ||
      !(event.metaKey || event.ctrlKey) ||
      event.altKey
    )
      return

    if (event.shiftKey && next === null) return

    event.preventDefault()

    if (event.shiftKey) props.onOpen(next!.pullRequest.ref)
    else void removeThenNext()
  })

  useEffect(() => {
    window.addEventListener("keydown", onShortcut)

    return () => window.removeEventListener("keydown", onShortcut)
  }, [])

  if (queued) {
    return (
      <Strip>
        <ol
          aria-label="Queue order"
          className="flex min-w-0 items-center gap-1 overflow-hidden p-1"
        >
          {entries.map((entry, index) => (
            <li key={entry.pullRequest.url}>
              <TooltipHint content={entry.pullRequest.title}>
                <button
                  type="button"
                  aria-label={entry.pullRequest.title}
                  aria-current={index === position || undefined}
                  onClick={() => props.onOpen(entry.pullRequest.ref)}
                  className={cn(
                    "block size-2.5 rounded-full",
                    entry.openedSinceQueued ? "bg-sky-500" : "bg-muted-foreground/30",
                    index === position &&
                      "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                  )}
                />
              </TooltipHint>
            </li>
          ))}
        </ol>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {position + 1} of {entries.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="px-3 text-xs leading-4 text-muted-foreground"
            aria-keyshortcuts="Meta+] Control+]"
            onClick={() => void removeThenNext()}
          >
            {next === null ? "Remove from queue" : "Remove & next"}
          </Button>
          {next !== null && (
            <Button
              variant="outline"
              size="sm"
              className="px-3 text-xs leading-4"
              aria-keyshortcuts="Meta+Shift+] Control+Shift+]"
              onClick={() => props.onOpen(next.pullRequest.ref)}
            >
              Next PR
            </Button>
          )}
        </div>
      </Strip>
    )
  }

  if (reviewedOut === null || referenceKey(reviewedOut.ref) !== key) return null

  const after = entries.length === 0 ? null : entries[reviewedOut.position % entries.length]!

  return (
    <Strip>
      <span className="text-muted-foreground">Reviewed · out of the Queue</span>
      {after !== null && (
        <Button
          variant="outline"
          size="sm"
          className="ml-auto px-3 text-xs leading-4"
          onClick={() => props.onOpen(after.pullRequest.ref)}
        >
          Next PR
        </Button>
      )}
    </Strip>
  )
}

function Strip(props: { children: ReactNode }) {
  const search = useAtomValue(listSearchAtom)

  return (
    <section
      aria-label="Queue"
      className="flex h-10 shrink-0 items-center gap-3 border-b bg-muted/40 px-6 text-sm"
    >
      <Link
        to="/reviews"
        search={{ ...search, list: "queue" }}
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium hover:bg-muted"
      >
        <ListOrdered className="size-4 text-muted-foreground" aria-hidden />
        Queue
      </Link>
      {props.children}
    </section>
  )
}

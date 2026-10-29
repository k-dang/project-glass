import type { PullRequest } from "@glass/contracts"
import { type KeyboardEvent, useEffect, useRef, useState } from "react"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { toast } from "@/components/ui/toast"
import { useReviewShortcuts } from "./useReviewShortcuts"

export function CopyMenu(props: { pullRequest: PullRequest }) {
  const [opener, setOpener] = useState<HTMLElement | null>(null)

  useReviewShortcuts([
    {
      key: "c",
      run: () => {
        setOpener(
          document.activeElement instanceof HTMLElement ? document.activeElement : document.body,
        )
      },
    },
  ])

  return opener === null ? null : (
    <CopyPanel pullRequest={props.pullRequest} opener={opener} onClose={() => setOpener(null)} />
  )
}

function CopyPanel(props: { pullRequest: PullRequest; opener: HTMLElement; onClose: () => void }) {
  const popup = useRef<HTMLDivElement>(null)
  const restoreFocus = useRef(true)
  const active = useRef(true)
  const copying = useRef(false)
  const [error, setError] = useState(false)
  const { pullRequest } = props

  useEffect(() => {
    active.current = true

    return () => {
      active.current = false
    }
  }, [])

  const actions = [
    { key: "g", label: "Copy link to PR", value: pullRequest.url, done: "PR link copied" },
    { key: "t", label: "Copy title", value: pullRequest.title, done: "Title copied" },
    {
      key: "b",
      label: "Copy PR branch name",
      value: pullRequest.headBranch,
      done: "Branch name copied",
    },
    {
      key: "c",
      label: "Copy CLI checkout command",
      value: `gh pr checkout ${pullRequest.url}`,
      done: "Checkout command copied",
    },
  ]

  const copy = async (action: (typeof actions)[number]) => {
    if (copying.current) return
    copying.current = true
    setError(false)

    try {
      await navigator.clipboard.writeText(action.value)

      if (!active.current) return
      props.onClose()
      toast.add({ type: "success", title: action.done, timeout: 2500 })
    } catch {
      if (active.current) setError(true)
    } finally {
      copying.current = false
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing || event.repeat) return

    if (event.key === "Tab") {
      restoreFocus.current = false
      props.opener.focus({ preventScroll: true })
      props.onClose()

      return
    }

    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
      restoreFocus.current = false
      props.onClose()

      return
    }

    event.preventDefault()
    const action = actions.find((entry) => entry.key === event.key.toLowerCase())

    if (action) void copy(action)
    else props.onClose()
  }

  return (
    <Dialog
      open
      modal={false}
      onOpenChange={(open, details) => {
        if (open) return

        if (
          details.reason === "escape-key" &&
          (details.event.defaultPrevented || details.event.isComposing || details.event.repeat)
        ) {
          details.cancel()

          return
        }

        if (details.reason === "outside-press" || details.reason === "focus-out")
          restoreFocus.current = false
        props.onClose()
      }}
    >
      <DialogContent
        ref={popup}
        initialFocus={popup}
        finalFocus={() =>
          restoreFocus.current && props.opener !== document.body ? props.opener : false
        }
        instant
        showCloseButton={false}
        showOverlay={false}
        className="w-[calc(100%-2rem)] gap-2 p-3 sm:max-w-sm"
        onKeyDown={onKeyDown}
      >
        <header className="flex items-center justify-between px-1 pb-1">
          <DialogTitle>Copy</DialogTitle>
          <Kbd>esc</Kbd>
        </header>
        <DialogDescription className="sr-only">
          Press G for the PR link, T for the title, B for the branch name, or C for the checkout
          command. Escape closes this menu.
        </DialogDescription>
        <ul>
          {actions.map((action) => (
            <li
              key={action.key}
              className="flex items-center justify-between gap-4 rounded px-1 py-1.5 text-sm"
            >
              <span>{action.label}</span>
              <KbdGroup className="shrink-0 font-sans text-xs text-muted-foreground">
                <Kbd>C</Kbd>
                <span>then</span>
                <Kbd>{action.key.toUpperCase()}</Kbd>
              </KbdGroup>
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="px-1 text-xs text-destructive">
            Couldn't copy to the clipboard. Press an action key to try again.
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

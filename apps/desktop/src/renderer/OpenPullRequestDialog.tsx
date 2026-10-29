import { parsePullRequestReference, type PullRequestRef } from "@glass/contracts"
import { GitPullRequestArrow } from "lucide-react"
import { type FormEvent, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { sameRef } from "./reviewsArea"
import { shortcutLabel } from "./shortcutLabel"
import { useReviewShortcuts } from "./useReviewShortcuts"

export function OpenPullRequestDialog(props: {
  current: PullRequestRef
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const [open, setOpen] = useState(false)

  const [address, setAddress] = useState("")

  const inputRef = useRef<HTMLInputElement>(null)

  const hintId = useId()

  const reference = parsePullRequestReference(address)

  const isCurrent = reference !== null && sameRef(reference, props.current)

  const show = (next: boolean) => {
    if (next) setAddress("")
    setOpen(next)
  }

  useReviewShortcuts([
    {
      key: "l",
      mod: true,
      allowInEditable: true,
      allowInDialog: true,
      run: () => {
        if (open) return inputRef.current?.select()

        setAddress("")
        setOpen(true)
      },
    },
  ])

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (reference === null) return

    setOpen(false)
    props.onOpen(reference)
  }

  const hint =
    address.trim() === ""
      ? "Paste a GitHub PR URL, or type owner/repo#number."
      : reference === null
        ? "Not a PR yet. Use a github.com/…/pull/N URL or owner/repo#123."
        : isCurrent
          ? "This PR is already open."
          : `Opens ${reference.owner}/${reference.repo}#${reference.number}`

  return (
    <Dialog open={open} onOpenChange={show}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Open another PR"
            aria-keyshortcuts="Meta+L Control+L"
            title={`Open another PR (${shortcutLabel("L")})`}
          />
        }
      >
        <GitPullRequestArrow aria-hidden />
      </DialogTrigger>
      <DialogContent
        instant
        showCloseButton={false}
        initialFocus={inputRef}
        className="top-[14vh] translate-y-0 gap-0 p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Open a PR</DialogTitle>
        <form onSubmit={submit}>
          <div className="flex items-center gap-2.5 border-b px-3.5">
            <GitPullRequestArrow className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <input
              ref={inputRef}
              aria-label="Open a PR"
              aria-describedby={hintId}
              placeholder="Paste a PR URL or owner/repo#123"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <p id={hintId} aria-live="polite" className="px-3.5 py-3 text-xs text-muted-foreground">
            {hint}
          </p>
          <div className="flex justify-end gap-3.5 border-t px-3.5 py-2 text-xs text-muted-foreground">
            <span>
              <Kbd>↵</Kbd> Open
            </span>
            <span>
              <Kbd>esc</Kbd> Close
            </span>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

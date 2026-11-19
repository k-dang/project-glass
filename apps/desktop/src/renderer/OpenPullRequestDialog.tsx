import { RegistryContext, useAtom, useAtomSet } from "@effect/atom-react"
import {
  findPullRequestReferences,
  parsePullRequestReference,
  type PullRequestRef,
} from "@glass/contracts"
import { Atom } from "effect/reactivity"
import { GitPullRequestArrow } from "lucide-react"
import { type FormEvent, type KeyboardEvent, useContext, useId, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { addToQueue, referenceText } from "./queue"
import { sameRef } from "./reviewsArea"
import { shortcutLabel } from "./shortcutLabel"
import { useShortcuts } from "./useShortcuts"

const openPullRequestDialogAtom = Atom.make(false)

export function OpenPullRequestButton() {
  const setOpen = useAtomSet(openPullRequestDialogAtom)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Open another PR"
      aria-keyshortcuts="Meta+L Control+L"
      title={`Open another PR (${shortcutLabel("L")})`}
      onClick={() => setOpen(true)}
    >
      <GitPullRequestArrow aria-hidden />
    </Button>
  )
}

export function OpenPullRequestDialog(props: {
  current: PullRequestRef | undefined
  onOpen: (pullRequest: PullRequestRef) => void
  onViewQueue: () => void
}) {
  const registry = useContext(RegistryContext)
  const [open, setOpen] = useAtom(openPullRequestDialogAtom)
  const [address, setAddress] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)
  const hintId = useId()
  const references = findPullRequestReferences(address)
  const reference = references.length > 1 ? null : parsePullRequestReference(address)

  const isCurrent =
    reference !== null && props.current !== undefined && sameRef(reference, props.current)

  const show = (next: boolean) => {
    if (next) setAddress("")
    setOpen(next)
  }

  useShortcuts([
    {
      key: "l",
      mod: true,
      allowInEditable: true,
      allowInDialog: true,
      run: () => {
        if (open) return inputRef.current?.select()

        show(true)
      },
    },
  ])

  const queue = () => {
    if (references.length === 0) return

    setOpen(false)
    void addToQueue(registry, references, props.onViewQueue)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (references.length > 1) return queue()

    if (reference === null) return

    setOpen(false)
    props.onOpen(reference)
  }

  const queueOnShortcut = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return

    event.preventDefault()
    queue()
  }

  const hint =
    address.trim() === ""
      ? "Paste a GitHub PR URL, or type owner/repo#number. Paste several to queue them all."
      : references.length > 1
        ? `Queues ${references.length} PRs: ${references.map(referenceText).join(", ")}`
        : reference === null
          ? "Not a PR yet. Use a github.com/…/pull/N URL or owner/repo#123."
          : isCurrent
            ? `This PR is already open. ${shortcutLabel("↵")} queues it.`
            : `Opens ${referenceText(reference)}`

  return (
    <Dialog open={open} onOpenChange={show}>
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
              onKeyDown={queueOnShortcut}
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
              <Kbd>↵</Kbd> {references.length > 1 ? "Queue all" : "Open"}
            </span>
            <span>
              <Kbd>{shortcutLabel("↵")}</Kbd> Add to Queue
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

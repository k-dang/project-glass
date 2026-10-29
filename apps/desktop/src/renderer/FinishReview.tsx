import { ReviewDecision } from "@glass/contracts"
import { ChevronDown, LoaderCircle, XIcon } from "lucide-react"
import { type FormEvent, useRef, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import { shortcutLabel } from "./shortcutLabel"
import { submitOnShortcut } from "./submitShortcut"
import {
  type DraftStore,
  useDraftCount,
  useDraftsLocked,
  useReviewSummary,
  useSubmission,
} from "./useDrafts"

const decisions: Record<
  ReviewDecision,
  { readonly label: string; readonly description: string; readonly done: string }
> = {
  comment: {
    label: "Comment",
    description: "Submit general feedback without explicit approval.",
    done: "Commented",
  },
  approve: {
    label: "Approve",
    description: "Submit feedback and approve merging these changes.",
    done: "Approved",
  },
  "request-changes": {
    label: "Request changes",
    description: "Submit feedback that must be addressed before merging.",
    done: "Requested changes",
  },
}

export function FinishReview(props: {
  store: DraftStore
  viewerIsAuthor: boolean
  onReload: () => void
}) {
  const { store } = props
  const draftCount = useDraftCount(store)
  const locked = useDraftsLocked(store)
  const summary = useReviewSummary(store)
  const submission = useSubmission(store)
  const [open, setOpen] = useState(false)
  const [decision, setDecision] = useState<ReviewDecision>("comment")
  const summaryRef = useRef<HTMLTextAreaElement>(null)
  const sending = submission.type === "sending"
  const failure = submission.type === "failed" ? submission.problem : null
  const awaitingReload = failure?.fixedByReload === true

  const chosen = props.viewerIsAuthor ? "comment" : decision
  const empty = chosen === "comment" && draftCount === 0 && summary.trim() === ""
  const blocked = empty || locked || awaitingReload || sending

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (blocked) return

    const outcome = await store.submit(chosen, summary)

    if (outcome.type === "submitted") {
      const { published } = outcome
      const { done } = decisions[chosen]

      store.setSummary("")
      setDecision("comment")
      setOpen(false)
      toast.add({
        type: "success",
        title: "Review submitted",
        description:
          published > 0 ? `${done} and published ${plural(published, "Draft")}.` : `${done}.`,
      })
      props.onReload()
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (
          !next &&
          sending &&
          (details.reason === "outside-press" || details.reason === "focus-out")
        ) {
          details.cancel()

          return
        }

        setOpen(next)
      }}
    >
      <PopoverTrigger render={<Button />}>
        Finish Review
        {draftCount > 0 && (
          <Badge className="h-4 bg-primary-foreground/20 px-1.5 tabular-nums">
            <span aria-hidden>{draftCount}</span>
            <span className="sr-only">, {plural(draftCount, "Draft")}</span>
          </Badge>
        )}
        <ChevronDown data-icon="inline-end" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        initialFocus={summaryRef}
        className="max-h-(--available-height) w-[27rem] max-w-(--available-width) gap-3 overflow-y-auto p-4"
      >
        <div className="-mt-1 -mr-2 flex shrink-0 items-center justify-between">
          <PopoverTitle className="font-semibold">Finish your Review</PopoverTitle>
          <PopoverClose render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
            <XIcon aria-hidden />
          </PopoverClose>
        </div>
        <form
          onSubmit={(event) => void submit(event)}
          className="flex min-h-0 shrink-0 flex-col gap-3"
        >
          {props.viewerIsAuthor && (
            <p className="text-sm text-muted-foreground">
              You opened this pull request, so GitHub takes only comments from you.
            </p>
          )}
          <Textarea
            ref={summaryRef}
            value={summary}
            onChange={(event) => {
              store.setSummary(event.target.value)

              if (!sending) store.clearSubmitFailure()
            }}
            onKeyDown={submitOnShortcut}
            readOnly={sending}
            placeholder="Leave an optional summary."
            aria-label="Review summary"
            className="h-24 min-h-24 resize-none field-sizing-fixed overflow-y-auto"
          />
          {!props.viewerIsAuthor && (
            <RadioGroup
              value={chosen}
              onValueChange={setDecision}
              disabled={sending}
              aria-label="Review decision"
              className="gap-1"
            >
              {ReviewDecision.literals.map((value) => (
                <label
                  key={value}
                  className="grid cursor-pointer grid-cols-[auto_1fr] items-center gap-x-2.5 rounded-lg px-2 py-1.5 text-sm font-medium hover:bg-muted has-data-disabled:cursor-default has-data-disabled:opacity-60"
                >
                  <RadioGroupItem value={value} />
                  {decisions[value].label}
                  <span className="col-start-2 text-xs font-normal text-muted-foreground">
                    {decisions[value].description}
                  </span>
                </label>
              ))}
            </RadioGroup>
          )}
          <div className="flex items-center gap-3 text-sm">
            <span className="flex-1 text-muted-foreground">
              {draftCount > 0 && `Publishes ${plural(draftCount, "Draft")}.`}
            </span>
            <Button type="submit" disabled={blocked}>
              {sending && (
                <LoaderCircle data-icon="inline-start" className="animate-spin" aria-hidden />
              )}
              Submit Review
              <kbd className="font-sans text-xs opacity-60" aria-hidden>
                {shortcutLabel("↵")}
              </kbd>
            </Button>
          </div>
          {failure !== null && (
            <ProblemAlert
              problem={failure}
              action={awaitingReload ? { label: "Reload", run: props.onReload } : undefined}
            />
          )}
        </form>
      </PopoverContent>
    </Popover>
  )
}

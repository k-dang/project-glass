import { RegistryContext } from "@effect/atom-react"
import {
  AgentReview,
  CapturedContext,
  type DogfoodReportRecorded,
  type DogfoodReportsBridge,
  type DogfoodReportSubject,
  Tour,
} from "@glass/contracts"
import { Option, Schema } from "effect"
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity"
import { type FormEvent, useContext, useEffect, useEffectEvent, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { copyText } from "./clipboard"
import { fileName } from "./fileName"
import { capturedContextAtom } from "./globalConversation"
import { submitOnShortcut } from "./submitShortcut"
import { agentReviewStates } from "./useAgentReview"
import { tourStates } from "./useTour"

const encodeContext = Schema.encodeSync(CapturedContext)

const encodeTour = Schema.encodeSync(Tour)

const encodeAgentReview = Schema.encodeSync(AgentReview)

const loaded = <A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) => Option.getOrNull(AsyncResult.value(registry.get(atom)))

/** What the screen is about, with the Tour and Agent review its PR workspace has loaded. */
const subjectOf = (registry: AtomRegistry.AtomRegistry): DogfoodReportSubject => {
  const context = registry.get(capturedContextAtom)
  const pullRequest = context?._tag === "PullRequest" ? context.pullRequest : null

  const tour =
    pullRequest === null ? null : (loaded(registry, tourStates(pullRequest))?.tour ?? null)

  const review =
    pullRequest === null ? null : (loaded(registry, agentReviewStates(pullRequest))?.review ?? null)

  return {
    route: window.location.hash.replace(/^#/, "") || "/",
    context: context === null ? null : encodeContext(context),
    tour: tour === null ? null : encodeTour(tour),
    agentReview: review === null ? null : encodeAgentReview(review),
  }
}

interface Pending extends DogfoodReportRecorded {
  readonly subject: DogfoodReportSubject
}

const isDogfoodShortcut = (event: KeyboardEvent) =>
  event.code === "Period" &&
  event.shiftKey &&
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.repeat

/** Records a Dogfood report on Mod+Shift+., then asks for its note. */
export function DogfoodReports(props: { bridge: DogfoodReportsBridge }) {
  const { bridge } = props
  const registry = useContext(RegistryContext)
  const [pending, setPending] = useState<Pending | null>(null)
  const [note, setNote] = useState("")
  const noteRef = useRef<HTMLTextAreaElement>(null)
  // The report in progress, read synchronously so one runs at a time and finishes only once.
  const current = useRef<Pending | "recording" | null>(null)

  const record = useEffectEvent(async () => {
    if (current.current !== null) return

    current.current = "recording"
    const subject = subjectOf(registry)

    try {
      // The screenshot is taken before the dialog opens, so it shows only what was on screen.
      const report = { ...(await bridge.record()), subject }
      current.current = report
      setNote("")
      setPending(report)
    } catch (error) {
      current.current = null
      toast.add({
        type: "error",
        title: "Couldn't record a Dogfood report",
        description: String(error),
      })
    }
  })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isDogfoodShortcut(event)) return

      event.preventDefault()
      void record()
    }

    window.addEventListener("keydown", onKeyDown, { capture: true })

    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])

  const takePending = () => {
    const report = current.current

    if (report === null || report === "recording") return null

    current.current = null
    setPending(null)

    return report
  }

  const finish = async (withNote: string) => {
    const report = takePending()

    if (report === null) return

    try {
      const { id, subject } = report
      const folder = await bridge.finish({ id, note: withNote, subject })

      toast.add({
        type: "success",
        title: "Dogfood report saved",
        description: fileName(folder),
        actionProps: {
          children: "Copy path",
          onClick: () => void copyText(folder, "Path copied"),
        },
      })
    } catch (error) {
      toast.add({
        type: "error",
        title: "Couldn't save the Dogfood report",
        description: String(error),
      })
    }
  }

  const discard = () => {
    const report = takePending()

    if (report !== null) void bridge.discard(report.id)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    void finish(note)
  }

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => !open && discard()}>
      <DialogContent initialFocus={noteRef} className="sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Dogfood report</DialogTitle>
            <DialogDescription>
              The screenshot, logs and settings are captured. Say what's broken or what should
              change.
            </DialogDescription>
          </DialogHeader>
          {pending !== null && (
            <img
              src={pending.screenshot}
              alt="What Glass showed"
              className="max-h-56 w-full rounded-md border object-contain object-top"
            />
          )}
          <Textarea
            ref={noteRef}
            aria-label="Note"
            placeholder="The Tour overview is too long to read at a glance…"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            onKeyDown={submitOnShortcut}
            className="min-h-24"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" className="sm:mr-auto" onClick={discard}>
              Discard
            </Button>
            <Button type="button" variant="ghost" onClick={() => void finish("")}>
              Save without a note
            </Button>
            <Button type="submit" disabled={note.trim() === ""}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

import { RegistryContext, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  findPullRequestReferences,
  type PullRequestRef,
  type QueuedPullRequest,
  type Revision,
  type TourState,
} from "@glass/contracts"
import { cn } from "cn"
import { Exit, Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import {
  Clock,
  ListPlus,
  LoaderCircle,
  type LucideIcon,
  Route,
  TriangleAlert,
  X,
} from "lucide-react"
import { type ClipboardEvent, type FormEvent, useContext, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Empty } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { describeError, type Problem, problemOf, problemText, settledProblem } from "./problems"
import {
  NotRefreshed,
  PullRequestRow,
  queueColumns,
  repositoryLabeller,
  subgridRow,
  warningTone,
} from "./PullRequestRow"
import {
  addToQueueAtom,
  describeAddition,
  queueRefreshAtom,
  referenceText,
  removeFromQueue,
  savedQueueAtom,
} from "./queue"
import { isOutdated, tourStates } from "./useTour"

export function QueueTabTrigger() {
  useAtomValue(queueRefreshAtom)
  const saved = useAtomValue(savedQueueAtom)
  const count = AsyncResult.isSuccess(saved) ? saved.value.length : 0

  return (
    <TabsTrigger value="queue" className="flex-none px-2">
      Queue
      {count > 0 && (
        <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </TabsTrigger>
  )
}

export function QueueTab(props: { onOpen: (pullRequest: PullRequestRef) => void }) {
  const saved = useAtomValue(savedQueueAtom)
  const retry = useAtomRefresh(savedQueueAtom)
  const notRefreshed = settledProblem(useAtomValue(queueRefreshAtom)) ?? undefined

  return (
    <div className="flex flex-col gap-2 pt-4">
      <QueueField />
      {notRefreshed !== undefined && (
        <output aria-label="Queue status" className="px-1 text-xs text-muted-foreground">
          <NotRefreshed problem={notRefreshed} showLabel />
        </output>
      )}
      {AsyncResult.builder(saved)
        .onInitial(() => (
          <output className="py-6 text-sm text-muted-foreground">Loading the Queue…</output>
        ))
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .onSuccess((entries) =>
          entries.length === 0 ? (
            <Empty title="Your Queue is empty">
              <p>Paste PR links into the field above, one at a time or a whole message at once.</p>
            </Empty>
          ) : (
            <ol aria-label="Queue" className={cn("grid gap-x-2.5", queueColumns)}>
              <QueueRows entries={entries} notRefreshed={notRefreshed} onOpen={props.onOpen} />
            </ol>
          ),
        )
        .render()}
    </div>
  )
}

function QueueRows(props: {
  entries: ReadonlyArray<QueuedPullRequest>
  notRefreshed: Problem | undefined
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const now = new Date()

  const repositoryLabel = repositoryLabeller(
    props.entries.map(({ pullRequest }) => pullRequest.ref),
  )

  return props.entries.map((queued) => (
    <QueueRow
      key={queued.pullRequest.url}
      queued={queued}
      repository={repositoryLabel(queued.pullRequest.ref)}
      notRefreshed={queued.problem === null ? props.notRefreshed : describeError(queued.problem)}
      now={now}
      onOpen={props.onOpen}
    />
  ))
}

function QueueRow(props: {
  queued: QueuedPullRequest
  repository: string
  notRefreshed: Problem | undefined
  now: Date
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const registry = useContext(RegistryContext)
  const { pullRequest, openedSinceQueued, state } = props.queued

  return (
    <li
      className={cn(
        subgridRow,
        "group/row relative hover:[&_time]:invisible has-focus-visible:[&_time]:invisible",
      )}
    >
      <PullRequestRow
        pullRequest={pullRequest}
        state={state}
        dimmed={props.notRefreshed !== undefined}
        notRefreshed={props.notRefreshed}
        now={props.now}
        repository={props.repository}
        onOpen={props.onOpen}
        marker={
          !openedSinceQueued && (
            <span className="relative col-start-1 self-center">
              <span className="absolute top-1/2 -left-3 size-1.5 -translate-y-1/2 rounded-full bg-sky-500" />
              <span className="sr-only">Not opened</span>
            </span>
          )
        }
        lead={<QueueTourStatus queued={props.queued} />}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${referenceText(pullRequest.ref)} from the Queue`}
        onClick={() => void removeFromQueue(registry, pullRequest.ref)}
        className="absolute top-1/2 right-1.5 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100"
      >
        <X aria-hidden />
      </Button>
    </li>
  )
}

interface TourStatus {
  readonly label: string
  readonly icon: LucideIcon
  readonly tone: string
  readonly spinning?: boolean
  readonly detail?: string
}

const tourStatus = (state: TourState, revision: Revision | null): TourStatus | null => {
  const { tour, job } = state

  if (job.status === "waiting")
    return { label: "Tour waiting", icon: Clock, tone: "text-muted-foreground" }

  if (job.status === "writing")
    return {
      label: "Writing Tour",
      icon: LoaderCircle,
      tone: "text-muted-foreground",
      spinning: true,
    }

  if (job.status === "failed")
    return {
      label: "Tour failed",
      icon: TriangleAlert,
      tone: "text-destructive",
      detail: job.reason.message,
    }

  if (tour === null) return null

  return revision !== null && isOutdated(tour, revision)
    ? { label: "Tour outdated", icon: Route, tone: warningTone }
    : { label: "Tour ready", icon: Route, tone: "text-foreground/70" }
}

function QueueTourStatus(props: { queued: QueuedPullRequest }) {
  const state = Option.getOrNull(
    AsyncResult.value(useAtomValue(tourStates(props.queued.pullRequest.ref))),
  )

  const status = state === null ? null : tourStatus(state, props.queued.revision)

  if (status === null) return null

  const Icon = status.icon
  const text = status.detail === undefined ? status.label : `${status.label}: ${status.detail}`

  return (
    <Tooltip>
      <TooltipTrigger render={<span className={cn("flex items-center", status.tone)} />}>
        <Icon
          aria-hidden
          className={cn("size-3.5", status.spinning && "animate-spin motion-reduce:animate-none")}
        />
        <span className="sr-only">{text}</span>
      </TooltipTrigger>
      <TooltipContent>{text}</TooltipContent>
    </Tooltip>
  )
}

function QueueField() {
  const result = useAtomValue(addToQueueAtom)
  const add = useAtomSet(addToQueueAtom, { mode: "promiseExit" })
  const [text, setText] = useState("")
  const [notALink, setNotALink] = useState(false)
  const adding = result.waiting

  const queue = async (references: ReadonlyArray<PullRequestRef>, entered: string) => {
    setNotALink(false)
    setText(entered)
    const exit = await add(references)

    if (Exit.isSuccess(exit) && exit.value.added.length + exit.value.alreadyQueued.length > 0) {
      setText("")
    }
  }

  const paste = (event: ClipboardEvent<HTMLInputElement>) => {
    const pasted = event.clipboardData.getData("text")
    const references = findPullRequestReferences(pasted)

    if (references.length === 0 || adding) return

    event.preventDefault()
    void queue(references, pasted)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (adding || text.trim() === "") return

    const references = findPullRequestReferences(text)

    if (references.length === 0) setNotALink(true)
    else void queue(references, text)
  }

  const note = notALink
    ? "Not a PR link"
    : adding
      ? "Looking up PRs on GitHub…"
      : AsyncResult.isSuccess(result)
        ? describeAddition(result.value)
        : AsyncResult.isFailure(result)
          ? problemText(problemOf(result.cause))
          : ""

  return (
    <form onSubmit={submit} className="flex flex-col gap-1">
      <div className="relative">
        <ListPlus
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          aria-label="Add to the Queue"
          placeholder="Paste PR links to queue them"
          value={text}
          readOnly={adding}
          aria-busy={adding}
          onChange={(event) => setText(event.target.value)}
          onPaste={paste}
          spellCheck={false}
          className="h-8 pl-8"
        />
      </div>
      <output
        aria-label="Queue field status"
        className="min-h-4 px-1 text-xs text-muted-foreground"
      >
        {note}
      </output>
    </form>
  )
}

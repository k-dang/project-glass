import type { Revision, TourState } from "@glass/contracts"
import { cn } from "cn"
import { Equal } from "effect"
import { BookOpen, Check, Clock, LoaderCircle, RotateCw, Route, Sparkles } from "lucide-react"
import { type ReactNode, useEffect, useEffectEvent, useRef } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Item, ItemContent, ItemMedia, ItemTitle } from "@/components/ui/item"
import { toast } from "@/components/ui/toast"
import { Elapsed } from "./Elapsed"
import { OutdatedNote } from "./OutdatedNote"
import { ProblemAlert } from "./ProblemAlert"
import type { TourChapter, TourReading } from "./tourReading"
import { twoDigits, useProgress } from "./tourProgress"
import { plural } from "./plural"
import { engineLabels, runnerLabel } from "./engines"
import { TourText } from "./TourText"
import type { ViewedFilesStore } from "./useViewedFiles"
import type { useTour } from "./useTour"

function ChapterRow(props: {
  chapter: TourChapter
  store: ViewedFilesStore
  onShow: (index: number) => void
}) {
  const { chapter } = props
  const progress = useProgress(props.store, chapter.paths)

  return (
    <Item render={<li />} size="xs" className="p-0">
      <button
        type="button"
        className="flex w-full items-start gap-2 rounded-lg px-1 py-2 text-left outline-none hover:bg-muted focus-visible:ring-[3px] focus-visible:ring-ring/50"
        onClick={() => props.onShow(chapter.index)}
      >
        <ItemMedia className="mt-0.5 font-mono text-xs text-muted-foreground">
          {twoDigits(chapter.index + 1)}
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle
            className={cn(
              "block w-auto line-clamp-none break-words",
              progress.done && "text-muted-foreground",
            )}
          >
            {chapter.title}
          </ItemTitle>
        </ItemContent>
        {progress.done ? (
          <Check
            aria-label="All files viewed"
            className="mt-0.5 size-3.5 shrink-0 text-(--viewed)"
          />
        ) : (
          progress.total > 0 && (
            <span
              aria-label={`${progress.count} of ${progress.total} files viewed`}
              className="mt-0.5 shrink-0 font-mono text-xs text-muted-foreground tabular-nums"
            >
              {progress.count}/{progress.total}
            </span>
          )
        )}
      </button>
    </Item>
  )
}

export function OutdatedTourBanner(props: { revision: Revision; action?: ReactNode }) {
  return (
    <OutdatedNote
      revision={props.revision}
      consequence="some Chapters may not match the diff"
      action={props.action}
    />
  )
}

export function RewriteTour(props: {
  tour: ReturnType<typeof useTour>
  variant: "outline" | "ghost"
}) {
  const { tour } = props

  if (tour.writing) return null

  return (
    <Button
      variant={props.variant}
      title="Write a new Tour"
      onClick={tour.write}
      disabled={tour.pending}
    >
      <RotateCw aria-hidden data-icon="inline-start" />
      Rewrite
    </Button>
  )
}

export function StartReading(props: { onShowChapter: (index: number) => void }) {
  return (
    <Button size="sm" onClick={() => props.onShowChapter(0)}>
      <BookOpen aria-hidden />
      Start reading
    </Button>
  )
}

const finishedWriting = (before: TourState | null, after: TourState | null) =>
  before?.job.status === "writing" &&
  after?.job.status === "idle" &&
  after.tour !== null &&
  (before.tour === null || !Equal.equals(before.tour.writtenAt, after.tour.writtenAt))

export const useTourReadyToast = (
  latest: TourState | null,
  reading: TourReading | null,
  onShowChapter: (index: number) => void,
) => {
  const before = useRef(latest)

  const announce = useEffectEvent(() => {
    if (reading === null) return undefined

    const id = toast.add({
      title: "Tour ready",
      description: `${plural(reading.chapters.length, "Chapter")}, most important first.`,
      actionProps: {
        children: "Start reading",
        onClick: () => {
          toast.close(id)
          onShowChapter(0)
        },
      },
    })

    return () => toast.close(id)
  })

  useEffect(() => {
    const previous = before.current
    before.current = latest

    return finishedWriting(previous, latest) ? announce() : undefined
  }, [latest])
}

export function TourCard(props: { reading: TourReading; onShowChapter: (index: number) => void }) {
  const { reading } = props

  return (
    <Card render={<section />} aria-label="Tour">
      <CardHeader>
        <CardTitle
          render={
            <h2>
              <Route aria-hidden className="size-4 text-muted-foreground" />
              Tour
            </h2>
          }
          className="flex items-center gap-2 text-sm"
        />
      </CardHeader>
      <CardContent>
        <p className="leading-relaxed break-words">
          <TourText text={reading.intent} />
        </p>
      </CardContent>
      <CardFooter className="flex-wrap gap-3">
        <StartReading onShowChapter={props.onShowChapter} />
        <span className="text-sm text-muted-foreground">
          {plural(reading.chapters.length, "Chapter")}
        </span>
      </CardFooter>
    </Card>
  )
}

export function TourSidebar(props: {
  tour: ReturnType<typeof useTour>
  reading: TourReading | null
  viewedFiles: ViewedFilesStore
  outdatedBanner: ReactNode
  onShowChapter: (index: number) => void
}) {
  const { tour } = props
  const { latest, subscriptionProblem, pending, commandFailure } = tour

  if (latest === null)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
        {subscriptionProblem !== null ? (
          <ProblemAlert
            problem={subscriptionProblem}
            action={{ label: "Try again", run: tour.reconnect }}
          />
        ) : (
          <p className="py-4 text-muted-foreground">Loading Tour…</p>
        )}
      </div>
    )

  const { job } = latest
  const { reading } = props

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm">
      {subscriptionProblem !== null && (
        <ProblemAlert
          problem={subscriptionProblem}
          action={{ label: "Try again", run: tour.reconnect }}
        />
      )}
      {commandFailure !== null && (
        <ProblemAlert
          problem={commandFailure.problem}
          action={{ label: "Try again", run: commandFailure.retry }}
        />
      )}
      {reading === null && job.status === "idle" && (
        <div className="space-y-4 px-1 py-3">
          <p className="leading-relaxed text-muted-foreground">
            A Tour orders this PR's files into Chapters and explains what each group does and why,
            using the description and diff.
          </p>
          <Button onClick={tour.write} disabled={pending}>
            <Sparkles data-icon="inline-start" aria-hidden />
            Write Tour
          </Button>
        </div>
      )}
      {job.status === "waiting" && (
        <div className="space-y-3 border-b px-1 py-3">
          <div className="flex items-center gap-2">
            <Clock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <output className="min-w-0 flex-1 font-medium">Waiting to write…</output>
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Glass writes Tours for queued PRs a few at a time. This one starts when another
            finishes.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={tour.write} disabled={pending}>
              <Sparkles data-icon="inline-start" aria-hidden />
              Write now
            </Button>
            <Button variant="outline" size="sm" onClick={tour.cancel} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {job.status === "writing" && (
        <div className="space-y-3 border-b px-1 py-3">
          <div className="flex items-center gap-2">
            <LoaderCircle
              aria-hidden
              className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            />
            <output className="min-w-0 flex-1 font-medium">
              {job.runner === null ? "Checking agent…" : "Writing Tour…"}
            </output>
            <Elapsed startedAt={job.startedAt} />
          </div>
          {job.runner !== null && (
            <p className="space-y-1 text-xs text-muted-foreground">
              <span className="block">{engineLabels[job.runner.engine]}</span>
              <span className="block break-all font-mono">{job.runner.model}</span>
            </p>
          )}
          <p className="text-xs leading-relaxed text-muted-foreground">
            You can keep reviewing or leave this PR. The Tour is saved when it's done.
          </p>
          <Button variant="outline" size="sm" onClick={tour.cancel} disabled={pending}>
            Cancel
          </Button>
        </div>
      )}
      {job.status === "failed" && (
        <Alert variant="destructive" className="my-3">
          <AlertTitle>Couldn't write the Tour.</AlertTitle>
          <AlertDescription className="space-y-3">
            {job.reason.runner !== null && (
              <p className="text-xs break-all">{runnerLabel(job.reason.runner)}</p>
            )}
            <p className="break-words">{job.reason.message}</p>
            <Button variant="outline" size="sm" onClick={tour.write} disabled={pending}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {reading !== null && (
        <section aria-label="Saved Tour" className="space-y-4 py-3">
          {props.outdatedBanner}
          <div className="px-1">
            <StartReading onShowChapter={props.onShowChapter} />
          </div>
          <p className="px-1 leading-relaxed break-words text-muted-foreground">
            <TourText text={reading.intent} />
          </p>
          <div className="flex items-center justify-between gap-2 px-1">
            <p className="text-xs text-muted-foreground">
              {plural(reading.chapters.length, "Chapter")}
            </p>
            <RewriteTour tour={tour} variant="ghost" />
          </div>
          <ol className="space-y-0.5">
            {reading.chapters.map((chapter) => (
              <ChapterRow
                key={chapter.index}
                chapter={chapter}
                store={props.viewedFiles}
                onShow={props.onShowChapter}
              />
            ))}
          </ol>
        </section>
      )}
    </div>
  )
}

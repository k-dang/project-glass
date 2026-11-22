import { useAtomValue } from "@effect/atom-react"
import {
  type DiffSide,
  LineReviewThread,
  type OriginalLine,
  type OutdatedReviewThread,
  type PublishedComment,
} from "@glass/contracts"
import { cn } from "cn"
import { DateTime } from "effect"
import { Check, ChevronRight, CircleCheck, CircleDot, LoaderCircle, RotateCw } from "lucide-react"
import { type FormEvent, type ReactNode, useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Textarea } from "@/components/ui/textarea"
import { TooltipHint } from "@/components/ui/tooltip"
import { GitHubHtml } from "./GitHubHtml"
import { plural } from "./plural"
import { submitOnShortcut } from "./submitShortcut"
import { problemText } from "./problems"
import { CommentReactions } from "./Reactions"
import { type ReplyStore, usePublishedReplies, useRepliesLocked, useReply } from "./useReplies"
import type { WriteView } from "./keyedWrites"
import type { Reactions, Resolutions } from "./workspaceFeedback"

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

export function Time(props: { time: DateTime.Utc }) {
  const date = DateTime.toDate(props.time)

  return (
    <time dateTime={date.toISOString()} className="text-muted-foreground">
      {timeFormat.format(date)}
    </time>
  )
}

const reviewThreadLine =
  "not-last:before:absolute not-last:before:top-8 not-last:before:-bottom-3 not-last:before:left-[11.5px] not-last:before:w-px not-last:before:bg-border not-last:before:content-['']"

function CommentLayout(props: {
  author: string
  avatarUrl: string | null
  aside: ReactNode
  children: ReactNode
  className?: string | undefined
}) {
  const { author, avatarUrl } = props

  return (
    <article className={cn("relative grid grid-cols-[24px_1fr] gap-x-3", props.className)}>
      <Avatar size="sm" aria-hidden>
        <AvatarImage src={avatarUrl ?? undefined} alt="" />
        <AvatarFallback className="font-medium text-foreground uppercase">
          {author[0]}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col gap-1">
        <header className="flex items-baseline gap-2 text-sm">
          <span className="font-medium">{author}</span>
          {props.aside}
        </header>
        {props.children}
      </div>
    </article>
  )
}

export function Comment(props: {
  comment: PublishedComment
  reactions: Reactions
  aside?: ReactNode
  className?: string
}) {
  const { author, avatarUrl, bodyHtml, createdAt } = props.comment

  return (
    <CommentLayout
      author={author}
      avatarUrl={avatarUrl}
      aside={
        <>
          <Time time={createdAt} />
          {props.aside}
        </>
      }
      className={props.className}
    >
      <GitHubHtml html={bodyHtml} className="text-sm" />
      <CommentReactions store={props.reactions} comment={props.comment} />
    </CommentLayout>
  )
}

function Published() {
  return (
    <span className="flex items-center gap-1 text-added">
      <Check className="size-3.5" aria-hidden />
      Published
    </span>
  )
}

const reviewThreadCard = "overflow-hidden rounded-lg border bg-card font-sans"

const reviewThreadHeader = "flex items-center gap-2 px-3 py-2 text-sm"

const reviewThreadComments = "flex flex-col gap-4 px-4 py-3"

function ReviewThreadTitle(props: { resolved: boolean; location: ReactNode }) {
  return (
    <>
      {props.resolved ? (
        <CircleCheck className="size-4 text-violet-500" aria-hidden />
      ) : (
        <CircleDot className="size-4 text-modified" aria-hidden />
      )}
      <span className="min-w-0 truncate">
        {props.resolved ? "Resolved" : "Unresolved"} Review thread on {props.location}
      </span>
    </>
  )
}

const reviewThreadPlace = (reviewThread: LineReviewThread | OutdatedReviewThread) => {
  const { path } = reviewThread

  if (reviewThread instanceof LineReviewThread) {
    const { side, line } = reviewThread

    return {
      location: <LineLocation side={side} line={line} />,
      name: pathLineName(path, side, line),
      aside: null,
      context: null,
    }
  }

  const { originalLine, diffHunk } = reviewThread

  return {
    location: (
      <TooltipHint content={path}>
        <span className="font-mono">
          {path}
          {originalLine !== "whole-file" && `:${originalLine}`}
        </span>
      </TooltipHint>
    ),
    name: `${path} ${originalLineName(originalLine)}`,
    aside: (
      <Badge variant="outline">{originalLine === "whole-file" ? "Whole file" : "Outdated"}</Badge>
    ),
    context: diffHunk !== "" && <DiffHunk hunk={diffHunk} />,
  }
}

export function ReviewThread(props: {
  reviewThread: LineReviewThread | OutdatedReviewThread
  replies: ReplyStore
  resolutions: Resolutions
  reactions: Reactions
}) {
  const { id, comments } = props.reviewThread
  const resolution = useAtomValue(props.resolutions.viewAtom(id))
  const resolved = resolution.confirmed ?? props.reviewThread.resolved
  const { location, name, aside, context } = reviewThreadPlace(props.reviewThread)
  const [opened, setOpened] = useState(false)
  const published = usePublishedReplies(props.replies, id)
  const open = !resolved || opened
  const count = comments.length + published.length
  const failed = resolution.feedback?.type === "failed" ? resolution.feedback : null

  const title = (
    <>
      <ReviewThreadTitle resolved={resolved} location={location} />
      {!open && (
        <span className="shrink-0 text-muted-foreground">· {plural(count, "comment")}</span>
      )}
    </>
  )

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpened}
      render={<section />}
      className={reviewThreadCard}
    >
      <header className={reviewThreadHeader}>
        {resolved ? (
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" />}
            className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-0 text-left font-normal aria-expanded:bg-transparent motion-safe:active:not-focus-visible:scale-100"
          >
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-panel-open/button:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            {title}
          </CollapsibleTrigger>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{title}</div>
        )}
        {aside}
        <ResolutionControl
          store={props.resolutions}
          reviewThreadId={id}
          name={name}
          resolved={resolved}
          view={resolution}
        />
      </header>
      {failed !== null && (
        <p className="border-t px-3 py-2 text-sm text-destructive">
          Couldn't {failed.input ? "resolve" : "unresolve"} this Review thread.{" "}
          {problemText(failed.problem)}
        </p>
      )}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden border-t transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-opacity">
        {context}
        <div className={reviewThreadComments}>
          {comments.map((comment) => (
            <Comment
              key={comment.id}
              comment={comment}
              reactions={props.reactions}
              className={reviewThreadLine}
            />
          ))}
          {published.map((comment) => (
            <Comment
              key={comment.id}
              comment={comment}
              reactions={props.reactions}
              className={reviewThreadLine}
              aside={<Published />}
            />
          ))}
        </div>
        <ReplyComposer store={props.replies} reviewThreadId={id} name={name} />
      </CollapsibleContent>
    </Collapsible>
  )
}

function ResolutionControl(props: {
  store: Resolutions
  reviewThreadId: string
  name: string
  resolved: boolean
  view: WriteView<boolean, boolean>
}) {
  const locked = useAtomValue(props.store.lockedAtom)
  const sending = props.view.feedback?.type === "sending" ? props.view.feedback : null
  const failed = props.view.feedback?.type === "failed" ? props.view.feedback : null
  const label = failed !== null ? "Retry" : props.resolved ? "Unresolve" : "Resolve"

  const accessible =
    failed !== null
      ? `Retry ${failed.input ? "resolving" : "unresolving"} Review thread on ${props.name}`
      : `${label} Review thread on ${props.name}`

  return (
    <>
      {sending !== null && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {sending.input ? "Resolving…" : "Unresolving…"}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={sending !== null || locked}
        aria-label={accessible}
        onClick={() =>
          props.store.set(props.reviewThreadId, failed !== null ? failed.input : !props.resolved)
        }
      >
        {failed !== null && <RotateCw data-icon="inline-start" aria-hidden />}
        {label}
      </Button>
    </>
  )
}

function ReplyComposer(props: { store: ReplyStore; reviewThreadId: string; name: string }) {
  const { store, reviewThreadId } = props
  const { body, feedback } = useReply(store, reviewThreadId)
  const locked = useRepliesLocked(store)
  const sending = feedback?.type === "sending"
  const problem = feedback?.type === "failed" ? feedback.problem : null

  const send = (event: FormEvent) => {
    event.preventDefault()
    store.send(reviewThreadId)
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-2 border-t px-4 py-3">
      <Textarea
        value={body}
        onChange={(event) => store.edit(reviewThreadId, event.target.value)}
        onKeyDown={submitOnShortcut}
        readOnly={sending || locked}
        placeholder="Reply. It publishes to GitHub right away."
        aria-label={`Reply to Review thread on ${props.name}`}
        className="min-h-9 bg-background"
      />
      {problem !== null && (
        <p className="text-sm text-destructive">
          Couldn't publish your Reply. {problemText(problem)}
        </p>
      )}
      {body.trim() !== "" && (
        <div className="flex items-center justify-end gap-2 text-sm">
          {sending && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              Sending…
            </span>
          )}
          <Button type="submit" size="sm" disabled={sending || locked}>
            {problem !== null && <RotateCw data-icon="inline-start" aria-hidden />}
            {problem === null ? "Reply" : "Retry"}
          </Button>
        </div>
      )}
    </form>
  )
}

export const lineName = (side: DiffSide, line: number) =>
  `line ${side === "new" ? "+" : "−"}${line}`

export const pathLineName = (path: string, side: DiffSide, line: number) =>
  `${path} ${lineName(side, line)}`

export const originalLineName = (originalLine: OriginalLine) =>
  originalLine === "whole-file" ? "(whole file)" : `line ${originalLine}`

export function LineLocation(props: { side: DiffSide; line: number }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap",
        props.side === "new" ? "text-added" : "text-deleted",
      )}
    >
      {lineName(props.side, props.line)}
    </span>
  )
}

export function DiffHunk(props: { hunk: string }) {
  return (
    <pre className="overflow-x-auto border-b bg-muted/40 py-2 font-mono text-xs leading-5">
      {props.hunk.split("\n").map((line, index) => (
        <div
          key={index}
          className={cn(
            "px-4",
            line.startsWith("+") && "bg-added/10",
            line.startsWith("-") && "bg-deleted/10",
            line.startsWith("@@") && "text-muted-foreground",
          )}
        >
          {line}
        </div>
      ))}
    </pre>
  )
}

export function OutdatedReviewThreads(props: {
  reviewThreads: ReadonlyArray<OutdatedReviewThread>
  replies: ReplyStore
  resolutions: Resolutions
  reactions: Reactions
}) {
  if (props.reviewThreads.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Outdated Review threads</h2>
      <p className="text-sm text-muted-foreground">
        Review threads that can't sit on a line of this Revision's diff: their lines changed since,
        they're on a whole file, or their file's diff isn't shown.
      </p>
      <ul className="flex flex-col gap-3">
        {props.reviewThreads.map((reviewThread) => (
          <li key={reviewThread.id}>
            <ReviewThread
              reviewThread={reviewThread}
              replies={props.replies}
              resolutions={props.resolutions}
              reactions={props.reactions}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

import { useAtomValue } from "@effect/atom-react"
import {
  type DiffSide,
  LineDiscussion,
  type OriginalLine,
  type OutdatedDiscussion,
  type PublishedComment,
  Review,
  type ReviewState,
  type Viewer,
} from "@glass/contracts"
import { cn } from "cn"
import { DateTime } from "effect"
import {
  Check,
  ChevronRight,
  CircleCheck,
  CircleDot,
  FileDiff,
  LoaderCircle,
  type LucideIcon,
  MessageSquare,
  RotateCw,
  Undo2,
} from "lucide-react"
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
import { type ReplyStore, usePublishedReplies, useRepliesLocked, useReply } from "./useReplies"
import { type Resolutions, type ResolutionView, useResolution } from "./useResolutions"

const timeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" })

function Time(props: { time: DateTime.Utc }) {
  const date = DateTime.toDate(props.time)

  return (
    <time dateTime={date.toISOString()} className="text-muted-foreground">
      {timeFormat.format(date)}
    </time>
  )
}

const threadLine =
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

function Comment(props: { comment: PublishedComment; aside?: ReactNode; className?: string }) {
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

const threadCard = "overflow-hidden rounded-lg border bg-card font-sans"

const threadHeader = "flex items-center gap-2 px-3 py-2 text-sm"

const threadComments = "flex flex-col gap-4 px-4 py-3"

function ThreadTitle(props: { resolved: boolean; location: ReactNode }) {
  return (
    <>
      {props.resolved ? (
        <CircleCheck className="size-4 text-violet-500" aria-hidden />
      ) : (
        <CircleDot className="size-4 text-modified" aria-hidden />
      )}
      <span className="min-w-0 truncate">
        {props.resolved ? "Resolved" : "Unresolved"} thread on {props.location}
      </span>
    </>
  )
}

const threadPlace = (discussion: LineDiscussion | OutdatedDiscussion) => {
  const { path } = discussion

  if (discussion instanceof LineDiscussion) {
    const { side, line } = discussion

    return {
      location: <LineLocation side={side} line={line} />,
      name: pathLineName(path, side, line),
      aside: null,
      context: null,
    }
  }

  const { originalLine, diffHunk } = discussion

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

export function DiscussionThread(props: {
  discussion: LineDiscussion | OutdatedDiscussion
  replies: ReplyStore
  resolutions: Resolutions
}) {
  const { id, comments } = props.discussion
  const resolution = useResolution(props.resolutions, id)
  const resolved = resolution.confirmed ?? props.discussion.resolved
  const { location, name, aside, context } = threadPlace(props.discussion)
  const [opened, setOpened] = useState(false)
  const published = usePublishedReplies(props.replies, id)
  const open = !resolved || opened
  const count = comments.length + published.length
  const failed = resolution.feedback?.type === "failed" ? resolution.feedback : null

  const title = (
    <>
      <ThreadTitle resolved={resolved} location={location} />
      {!open && (
        <span className="shrink-0 text-muted-foreground">· {plural(count, "comment")}</span>
      )}
    </>
  )

  return (
    <Collapsible open={open} onOpenChange={setOpened} render={<section />} className={threadCard}>
      <header className={threadHeader}>
        {resolved ? (
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" />}
            className="h-auto min-w-0 flex-1 justify-start gap-2 px-0 py-0 text-left font-normal aria-expanded:bg-transparent"
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
          discussionId={id}
          name={name}
          resolved={resolved}
          view={resolution}
        />
      </header>
      {failed !== null && (
        <p className="border-t px-3 py-2 text-sm text-destructive">
          Couldn't {failed.resolved ? "resolve" : "unresolve"} this Discussion.{" "}
          {problemText(failed.problem)}
        </p>
      )}
      <CollapsibleContent className="h-(--collapsible-panel-height) overflow-hidden border-t transition-[height,opacity] duration-200 ease-out data-starting-style:h-0 data-starting-style:opacity-0 data-ending-style:h-0 data-ending-style:opacity-0 motion-reduce:transition-opacity">
        {context}
        <div className={threadComments}>
          {comments.map((comment) => (
            <Comment key={comment.id} comment={comment} className={threadLine} />
          ))}
          {published.map((comment) => (
            <Comment
              key={comment.id}
              comment={comment}
              className={threadLine}
              aside={<Published />}
            />
          ))}
        </div>
        <ReplyComposer store={props.replies} discussionId={id} name={name} />
      </CollapsibleContent>
    </Collapsible>
  )
}

export function PublishedDraftThread(props: { location: ReactNode; viewer: Viewer; body: string }) {
  const { login, avatarUrl } = props.viewer

  return (
    <section className={threadCard}>
      <header className={threadHeader}>
        <ThreadTitle resolved={false} location={props.location} />
      </header>
      <div className={cn("border-t", threadComments)}>
        <CommentLayout author={login} avatarUrl={avatarUrl} aside={<Published />}>
          <p className="text-sm whitespace-pre-wrap">{props.body}</p>
        </CommentLayout>
      </div>
    </section>
  )
}

function ResolutionControl(props: {
  store: Resolutions
  discussionId: string
  name: string
  resolved: boolean
  view: ResolutionView
}) {
  const locked = useAtomValue(props.store.lockedAtom)
  const sending = props.view.feedback?.type === "sending" ? props.view.feedback : null
  const failed = props.view.feedback?.type === "failed" ? props.view.feedback : null
  const label = failed !== null ? "Retry" : props.resolved ? "Unresolve" : "Resolve"

  const accessible =
    failed !== null
      ? `Retry ${failed.resolved ? "resolving" : "unresolving"} thread on ${props.name}`
      : `${label} thread on ${props.name}`

  return (
    <>
      {sending !== null && (
        <span className="flex items-center gap-1 text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {sending.resolved ? "Resolving…" : "Unresolving…"}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={sending !== null || locked}
        aria-label={accessible}
        onClick={() =>
          props.store.set(props.discussionId, failed !== null ? failed.resolved : !props.resolved)
        }
      >
        {failed !== null && <RotateCw data-icon="inline-start" aria-hidden />}
        {label}
      </Button>
    </>
  )
}

function ReplyComposer(props: { store: ReplyStore; discussionId: string; name: string }) {
  const { store, discussionId } = props
  const { body, feedback } = useReply(store, discussionId)
  const locked = useRepliesLocked(store)
  const sending = feedback?.type === "sending"
  const problem = feedback?.type === "failed" ? feedback.problem : null

  const send = (event: FormEvent) => {
    event.preventDefault()
    store.send(discussionId)
  }

  return (
    <form onSubmit={send} className="flex flex-col gap-2 border-t px-4 py-3">
      <Textarea
        value={body}
        onChange={(event) => store.edit(discussionId, event.target.value)}
        onKeyDown={submitOnShortcut}
        readOnly={sending || locked}
        placeholder="Reply. It publishes to GitHub right away."
        aria-label={`Reply to thread on ${props.name}`}
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
    <span className={props.side === "new" ? "text-added" : "text-deleted"}>
      {lineName(props.side, props.line)}
    </span>
  )
}

const states: Record<
  ReviewState,
  { readonly verb: string; readonly icon: LucideIcon; readonly className: string }
> = {
  comment: { verb: "reviewed", icon: MessageSquare, className: "text-muted-foreground" },
  approve: { verb: "approved these changes", icon: CircleCheck, className: "text-added" },
  "request-changes": {
    verb: "requested changes",
    icon: FileDiff,
    className: "text-deleted",
  },
  dismissed: { verb: "had a review dismissed", icon: Undo2, className: "text-muted-foreground" },
}

function ReviewEntry(props: { review: Review }) {
  const { author, state, bodyHtml, submittedAt } = props.review
  const { verb, icon: Icon, className } = states[state]

  return (
    <li className="overflow-hidden rounded-lg border">
      <header className="flex items-center gap-2 px-4 py-3 text-sm">
        <Icon className={cn("size-4", className)} aria-hidden />
        <span className="font-medium">{author}</span>
        <span>{verb}</span>
        <Time time={submittedAt} />
      </header>
      {bodyHtml !== "" && <GitHubHtml html={bodyHtml} className="border-t px-4 py-3 text-sm" />}
    </li>
  )
}

export function Timeline(props: { items: ReadonlyArray<PublishedComment | Review> }) {
  if (props.items.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Comments and Reviews</h2>
      <ol className="flex flex-col gap-3">
        {props.items.map((item) =>
          item instanceof Review ? (
            <ReviewEntry key={item.id} review={item} />
          ) : (
            <li key={item.id} className="rounded-lg border px-4 py-3">
              <Comment comment={item} />
            </li>
          ),
        )}
      </ol>
    </section>
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

export function OutdatedDiscussions(props: {
  discussions: ReadonlyArray<OutdatedDiscussion>
  replies: ReplyStore
  resolutions: Resolutions
}) {
  if (props.discussions.length === 0) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-semibold">Outdated Discussions</h2>
      <p className="text-sm text-muted-foreground">
        Discussions that can't sit on a line of this Revision's diff: their lines changed since,
        they're on a whole file, or their file's diff isn't shown.
      </p>
      <ul className="flex flex-col gap-3">
        {props.discussions.map((discussion) => (
          <li key={discussion.id}>
            <DiscussionThread
              discussion={discussion}
              replies={props.replies}
              resolutions={props.resolutions}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

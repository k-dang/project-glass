import { type PublishedComment, Review, type ReviewState } from "@glass/contracts"
import { cn } from "cn"
import { CircleCheck, FileDiff, type LucideIcon, MessageSquare, Undo2 } from "lucide-react"
import { GitHubHtml } from "./GitHubHtml"
import { Comment, Time } from "./ReviewThreads"
import type { Reactions } from "./workspaceFeedback"

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

export function Timeline(props: {
  items: ReadonlyArray<PublishedComment | Review>
  reactions: Reactions
}) {
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
              <Comment comment={item} reactions={props.reactions} />
            </li>
          ),
        )}
      </ol>
    </section>
  )
}

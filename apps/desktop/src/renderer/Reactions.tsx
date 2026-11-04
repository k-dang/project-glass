import { useAtomValue } from "@effect/atom-react"
import { type PublishedComment, Reaction } from "@glass/contracts"
import { cn } from "cn"
import { RotateCw, SmilePlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Popover, PopoverClose, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { problemText } from "./problems"
import { type Reactions, useReactions } from "./useReactions"

const emoji: Record<Reaction, { readonly symbol: string; readonly name: string }> = {
  "thumbs-up": { symbol: "👍", name: "thumbs up" },
  "thumbs-down": { symbol: "👎", name: "thumbs down" },
  laugh: { symbol: "😄", name: "laugh" },
  hooray: { symbol: "🎉", name: "hooray" },
  confused: { symbol: "😕", name: "confused" },
  heart: { symbol: "❤️", name: "heart" },
  rocket: { symbol: "🚀", name: "rocket" },
  eyes: { symbol: "👀", name: "eyes" },
}

export function CommentReactions(props: { store: Reactions; comment: PublishedComment }) {
  const { store, comment } = props
  const view = useReactions(store, comment.id)
  const locked = useAtomValue(store.lockedAtom)
  const groups = view.confirmed ?? comment.reactions
  const failed = view.feedback?.type === "failed" ? view.feedback : null
  const disabled = view.feedback?.type === "sending" || locked
  const reacted = new Set(groups.flatMap((group) => (group.reacted ? [group.reaction] : [])))

  const toggle = (reaction: Reaction) =>
    store.set(comment.id, { reaction, reacted: !reacted.has(reaction) })

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1">
        {groups.map(({ reaction, count, reacted: mine }) => (
          <Button
            key={reaction}
            type="button"
            variant="outline"
            size="xs"
            aria-pressed={mine}
            aria-label={`${emoji[reaction].name}: ${count}${mine ? ", including you" : ""}`}
            disabled={disabled}
            onClick={() => toggle(reaction)}
            className={cn("rounded-full tabular-nums", mine && "border-primary/40 bg-primary/10")}
          >
            <span aria-hidden>{emoji[reaction].symbol}</span>
            {count}
          </Button>
        ))}
        <Popover>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`React to ${comment.author}'s comment`}
                disabled={disabled}
                className="rounded-full text-muted-foreground"
              />
            }
          >
            <SmilePlus aria-hidden />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto flex-row gap-0.5 p-1">
            {Reaction.literals.map((reaction) => (
              <PopoverClose
                key={reaction}
                render={<Button type="button" variant="ghost" size="icon-sm" />}
                aria-label={emoji[reaction].name}
                aria-pressed={reacted.has(reaction)}
                disabled={disabled}
                onClick={() => toggle(reaction)}
                className={cn(reacted.has(reaction) && "bg-primary/10")}
              >
                <span aria-hidden>{emoji[reaction].symbol}</span>
              </PopoverClose>
            ))}
          </PopoverContent>
        </Popover>
      </div>
      {failed !== null && (
        <p className="flex items-center gap-2 text-sm text-destructive">
          Couldn't {failed.input.reacted ? "add" : "remove"} your{" "}
          {emoji[failed.input.reaction].name}. {problemText(failed.problem)}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={locked}
            onClick={() => store.set(comment.id, failed.input)}
          >
            <RotateCw data-icon="inline-start" aria-hidden />
            Retry
          </Button>
        </p>
      )}
    </div>
  )
}

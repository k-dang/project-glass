import { ListTodo } from "lucide-react"
import { cn } from "cn"

export function MentionChip(props: { title: string; className?: string }) {
  return (
    <span
      data-slot="mention"
      className={cn(
        "inline-flex items-baseline gap-1 rounded-sm bg-background/70 px-1 font-medium",
        props.className,
      )}
    >
      <ListTodo aria-hidden className="size-3.5 shrink-0 self-center" />
      {props.title}
    </span>
  )
}

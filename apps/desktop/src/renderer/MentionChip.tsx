import { type Mentioned } from "@glass/contracts"
import { FileText, ListTodo } from "lucide-react"
import { cn } from "cn"
import { fileName } from "./fileName"

export const mentionLabel = (mentioned: Mentioned) =>
  mentioned.kind === "toDo" ? mentioned.title : fileName(mentioned.path)

export function MentionChip(props: { mentioned: Mentioned; className?: string }) {
  const { mentioned } = props
  const Icon = mentioned.kind === "toDo" ? ListTodo : FileText

  return (
    <span
      data-slot="mention"
      title={mentioned.kind === "file" ? mentioned.path : undefined}
      className={cn(
        "inline-flex items-baseline gap-1 rounded-sm bg-background/70 px-1 font-medium",
        props.className,
      )}
    >
      <Icon aria-hidden className="size-3.5 shrink-0 self-center" />
      {mentionLabel(mentioned)}
    </span>
  )
}

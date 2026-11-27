import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { Option } from "effect"
import { inboxCountAtom } from "./inboxArea"

export function InboxSummary() {
  const label = Option.match(useAtomValue(inboxCountAtom), {
    onNone: () => "Open Inbox",
    onSome: (count) => `Inbox: ${count} waiting`,
  })

  return (
    <Link
      to="/inbox"
      className="flex h-10 items-center justify-between rounded-md border px-3 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="font-medium">{label}</span>
      <span aria-hidden className="text-muted-foreground">
        →
      </span>
    </Link>
  )
}

export function InboxHeadingCount() {
  const count = useAtomValue(inboxCountAtom)

  if (Option.isNone(count)) return null

  return <span className="font-normal text-muted-foreground">{count.value}</span>
}

export function InboxBadge(props: { id: string; count: number }) {
  return (
    <span
      id={props.id}
      className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums"
    >
      {props.count}
      <span className="sr-only"> waiting</span>
    </span>
  )
}

import { useAtomValue } from "@effect/atom-react"
import { Link } from "@tanstack/react-router"
import { Option } from "effect"
import { needsYouCount, needsYouStatus, watchedNeedsYouAtom } from "./needsYou"

export function NeedsYouSummary() {
  const count = needsYouCount(needsYouStatus(useAtomValue(watchedNeedsYouAtom)))

  const label = Option.match(count, {
    onNone: () => "Needs you",
    onSome: (value) => `Needs you ${value}`,
  })

  return (
    <Link
      to="/inbox"
      className="flex h-10 items-center justify-between rounded-md border px-3 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="font-medium">{label}</span>
      <span aria-hidden className="text-muted-foreground">
        Inbox →
      </span>
    </Link>
  )
}

export function NeedsYouBadge(props: { id: string }) {
  const count = needsYouCount(needsYouStatus(useAtomValue(watchedNeedsYouAtom)))

  if (Option.isNone(count) || count.value === 0) return null

  return (
    <span
      id={props.id}
      className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums"
    >
      {count.value}
      <span className="sr-only"> need you</span>
    </span>
  )
}

import { Link, type LinkProps } from "@tanstack/react-router"
import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"
import { Button } from "@/components/ui/button"

export function Empty(props: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center text-sm text-muted-foreground">
      <h2 className="text-base font-semibold text-foreground">{props.title}</h2>
      {props.children}
    </div>
  )
}

export function Count(props: { count: number }) {
  if (props.count === 0) return null

  return (
    <span className="rounded-full bg-muted px-1.5 text-xs text-muted-foreground tabular-nums">
      {props.count}
    </span>
  )
}

export function SectionLink(props: { link: LinkProps; children: ReactNode }) {
  return (
    <Link
      {...props.link}
      className="ml-auto flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      {props.children} <ArrowRight className="size-3.5" aria-hidden />
    </Link>
  )
}

export function LoadMore(props: {
  label: string
  loading: boolean
  disabled: boolean
  onMore: () => void
}) {
  return (
    <div className="pt-4">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={props.disabled}
        onClick={props.onMore}
      >
        {props.loading ? "Loading more…" : props.label}
      </Button>
    </div>
  )
}

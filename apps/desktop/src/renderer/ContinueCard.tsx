import { Link, type LinkProps } from "@tanstack/react-router"
import { ArrowRight, type LucideIcon } from "lucide-react"
import type { ReactNode } from "react"

export const rememberPlaceHint =
  "Open a pull request or an Agent and Glass will remember your place."

export function ContinueCard(props: {
  link: LinkProps
  name: string
  heading?: ReactNode
  icon: LucideIcon
  subtitle: string
  children?: ReactNode
}) {
  const Icon = props.icon

  return (
    <Link
      {...props.link}
      aria-label={`Continue ${props.name}`}
      className="flex min-w-0 items-center gap-4 rounded-xl border bg-muted/20 p-5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-base font-medium" title={props.name}>
          {props.heading ?? props.name}
        </p>
        <p className="mt-1 truncate text-sm text-muted-foreground">{props.subtitle}</p>
        {props.children}
      </div>
      <span className="flex shrink-0 items-center gap-2 text-sm font-medium">
        Continue <ArrowRight className="size-4" aria-hidden />
      </span>
    </Link>
  )
}

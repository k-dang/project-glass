import { Link, type LinkProps } from "@tanstack/react-router"
import { ArrowRight, type LucideIcon } from "lucide-react"
import { type ReactNode, useId } from "react"

const slot =
  "flex min-w-0 items-center gap-4 rounded-xl border p-5 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"

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
    <Link {...props.link} aria-label={`Continue ${props.name}`} className={`${slot} bg-muted/20`}>
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

export function ContinueInvitation(props: {
  link: LinkProps
  icon: LucideIcon
  title: string
  hint: string
  action: string
}) {
  const Icon = props.icon
  const titleId = useId()

  return (
    <Link
      {...props.link}
      aria-label={props.action}
      aria-describedby={titleId}
      className={`group ${slot} border-dashed`}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p id={titleId} className="text-base font-medium">
          {props.title}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{props.hint}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground group-hover:text-foreground">
        {props.action} <ArrowRight className="size-4" aria-hidden />
      </span>
    </Link>
  )
}

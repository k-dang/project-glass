import { useAtomValue } from "@effect/atom-react"
import type { PullRequestRef, PullRequestSummary } from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { Option } from "effect"
import type { ComponentProps } from "react"
import { AsyncResult } from "effect/reactivity"
import { buttonVariants } from "@/components/ui/button"
import { TooltipHint } from "@/components/ui/tooltip"
import { conversationPullRequestsAtom } from "./conversationsArea"
import { ChecksIcon, checksLabels } from "./status"

export const useConversationPullRequest = (conversationId: string) =>
  Option.getOrUndefined(AsyncResult.value(useAtomValue(conversationPullRequestsAtom)))?.get(
    conversationId,
  )

export const pullRequestLabel = ({ ref, checks }: PullRequestSummary) =>
  `PR #${ref.number}, checks ${checksLabels[checks].label.toLowerCase()}`

export function PullRequestLink({
  href,
  pullRequest,
  onClick,
  children,
  ...props
}: ComponentProps<"a"> & { href: string; pullRequest: PullRequestRef }) {
  const navigate = useNavigate()

  return (
    <a
      {...props}
      href={href}
      rel="noreferrer"
      target="_blank"
      onClick={(event) => {
        onClick?.(event)

        const opensInBrowser = event.metaKey || event.ctrlKey

        if (opensInBrowser) return

        event.preventDefault()
        void navigate({ to: "/reviews/$owner/$repo/$number", params: pullRequest })
      }}
    >
      {children}
    </a>
  )
}

export function ConversationPullRequestLink(props: { pullRequest: PullRequestSummary }) {
  const { pullRequest } = props

  return (
    <TooltipHint content={pullRequest.title} side="bottom">
      <PullRequestLink
        href={pullRequest.url}
        pullRequest={pullRequest.ref}
        aria-label={`Open ${pullRequestLabel(pullRequest)}`}
        className={cn(
          buttonVariants({ variant: "ghost", size: "sm" }),
          "shrink-0 gap-1.5 tabular-nums",
        )}
      >
        <ChecksIcon checks={pullRequest.checks} className="size-3.5" />#{pullRequest.ref.number}
      </PullRequestLink>
    </TooltipHint>
  )
}

export function ConversationPullRequestBadge(props: {
  id: string
  pullRequest: PullRequestSummary
}) {
  const { pullRequest } = props

  return (
    <span
      id={props.id}
      className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <ChecksIcon checks={pullRequest.checks} className="size-3" />
      <span aria-hidden>#{pullRequest.ref.number}</span>
      <span className="sr-only">{pullRequestLabel(pullRequest)}</span>
    </span>
  )
}

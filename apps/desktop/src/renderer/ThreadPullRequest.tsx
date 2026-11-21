import { useAtomValue } from "@effect/atom-react"
import type { ThreadPullRequest, ThreadPullRequestState, PullRequestRef } from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { Match, Option } from "effect"
import { type ComponentProps, createContext, use } from "react"
import { AsyncResult } from "effect/reactivity"
import { buttonVariants } from "@/components/ui/button"
import { TooltipHint } from "@/components/ui/tooltip"
import { threadPullRequestsAtom } from "./threadsArea"
import { checksLabels, closedLabel, mergedLabel, StatusIcon, type StatusLabel } from "./status"

export const PullRequestPanes = createContext<((pullRequest: PullRequestRef) => void) | null>(null)

export const useThreadPullRequest = (threadId: string) =>
  Option.getOrUndefined(AsyncResult.value(useAtomValue(threadPullRequestsAtom)))?.get(threadId)

const statusOf = (state: ThreadPullRequestState): StatusLabel =>
  Match.valueTags(state, {
    Open: ({ checks }) => ({
      ...checksLabels[checks],
      label: `checks ${checksLabels[checks].label.toLowerCase()}`,
    }),
    Merged: () => ({ ...mergedLabel, label: "merged" }),
    Closed: () => ({ ...closedLabel, label: "closed" }),
  })

export const pullRequestLabel = ({ ref, state }: ThreadPullRequest) =>
  `PR #${ref.number}, ${statusOf(state).label}`

export function PullRequestStatusIcon(props: { state: ThreadPullRequestState; className: string }) {
  return <StatusIcon status={statusOf(props.state)} className={props.className} />
}

export function PullRequestLink({
  href,
  pullRequest,
  onClick,
  children,
  ...props
}: ComponentProps<"a"> & { href: string; pullRequest: PullRequestRef }) {
  const navigate = useNavigate()
  const openPane = use(PullRequestPanes)

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

        if (openPane !== null) return openPane(pullRequest)

        void navigate({ to: "/reviews/$owner/$repo/$number", params: pullRequest })
      }}
    >
      {children}
    </a>
  )
}

export function ThreadPullRequestLink(props: { pullRequest: ThreadPullRequest }) {
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
        <PullRequestStatusIcon state={pullRequest.state} className="size-3.5" />#
        {pullRequest.ref.number}
      </PullRequestLink>
    </TooltipHint>
  )
}

export function ThreadPullRequestBadge(props: { id: string; pullRequest: ThreadPullRequest }) {
  const { pullRequest } = props

  return (
    <span
      id={props.id}
      className="ml-auto flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums"
    >
      <PullRequestStatusIcon state={pullRequest.state} className="size-3" />
      <span aria-hidden>#{pullRequest.ref.number}</span>
      <span className="sr-only">{pullRequestLabel(pullRequest)}</span>
    </span>
  )
}

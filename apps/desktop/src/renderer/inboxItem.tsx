import type { NeedsYouGroup, NeedsYouItem, PullRequestReason, RequestPart } from "@glass/contracts"
import { cn } from "cn"
import { Array as Arr, DateTime, Match, Predicate } from "effect"
import { CircleHelp, FileDiff, GitPullRequest, MessagesSquare, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { fileName } from "./fileName"
import { ago } from "./PullRequestRow"
import { turnEndingLooks, warningTone } from "./status"
import { referenceText } from "./queue"

type Tone = "warning" | "danger" | "review" | "success" | "neutral"

const toneClass: Record<Tone, string> = {
  warning: warningTone,
  danger: "text-deleted",
  review: "text-violet-600 dark:text-violet-400",
  success: "text-added",
  neutral: "text-muted-foreground",
}

export const groupLooks: Record<NeedsYouGroup, { readonly label: string; readonly tone: string }> =
  {
    stopped: { label: "Stopped on you", tone: warningTone },
    reviews: { label: "Agent reviews to read", tone: "text-muted-foreground" },
    mine: { label: "Your pull requests", tone: "text-muted-foreground" },
    finished: { label: "Threads that finished", tone: "text-muted-foreground" },
  }

export const inboxKeys = ["E", "A"] as const

export interface InboxAction {
  readonly key: (typeof inboxKeys)[number]
  readonly label: string
  readonly run: () => void
}

interface Reason {
  readonly label: string
  readonly tone: string
}

const requestReason = (part: RequestPart): Reason =>
  Match.valueTags(part, {
    PermissionRequest: () => ({ label: "Permission request", tone: toneClass.warning }),
    Question: () => ({ label: "Question", tone: toneClass.warning }),
  })

const pullRequestReason = (reason: PullRequestReason): Reason =>
  Match.valueTags(reason, {
    AgentReviewFinished: () => ({ label: "Agent review finished", tone: toneClass.review }),
    ChangesRequested: () => ({ label: "Changes requested", tone: toneClass.danger }),
    ChecksFailing: () => ({ label: "CI failing", tone: toneClass.danger }),
    AwaitingReply: ({ reviewThreads }) => ({
      label:
        reviewThreads === 1
          ? "1 Review thread awaiting reply"
          : `${reviewThreads} Review threads awaiting reply`,
      tone: toneClass.neutral,
    }),
    ReadyToMerge: () => ({ label: "Ready to merge", tone: toneClass.success }),
  })

const reasonsOf = (item: NeedsYouItem): ReadonlyArray<Reason> =>
  Arr.dedupeWith(
    Match.valueTags(item, {
      Thread: ({ reasons }) =>
        reasons.flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map(requestReason),
            TurnFinished: ({ ended }) => [turnEndingLooks[ended.ending._tag]],
          }),
        ),
      OutsideQuestion: () => [{ label: "Question", tone: toneClass.warning }],
      CheckIn: () => [{ label: "Check-in", tone: toneClass.warning }],
      PullRequest: ({ reasons }) => reasons.map(pullRequestReason),
      GlobalChat: ({ requests }) => requests.map(requestReason),
    }),
    (a, b) => a.label === b.label,
  )

export function Reasons(props: { item: NeedsYouItem }) {
  return reasonsOf(props.item).map((reason) => (
    <Badge
      key={reason.label}
      variant="outline"
      className={cn("rounded-sm px-1.5 font-normal", reason.tone)}
    >
      {reason.label}
    </Badge>
  ))
}

export function ItemIcon(props: { item: NeedsYouItem; className: string }) {
  return Match.valueTags(props.item, {
    Thread: () => <Sparkles className={props.className} aria-hidden />,
    OutsideQuestion: () => <CircleHelp className={props.className} aria-hidden />,
    CheckIn: () => <FileDiff className={props.className} aria-hidden />,
    PullRequest: () => <GitPullRequest className={props.className} aria-hidden />,
    GlobalChat: () => <MessagesSquare className={props.className} aria-hidden />,
  })
}

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Thread: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, {
          WaitingRequests: ({ requests }) => requests,
          TurnFinished: () => [],
        }),
      ),
    OutsideQuestion: () => [],
    CheckIn: () => [],
    PullRequest: () => [],
    GlobalChat: ({ requests }) => requests,
  })

export const firstPermission = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Thread: (waiting) => {
      const part = requestsOf(waiting).find((request) =>
        Predicate.isTagged(request, "PermissionRequest"),
      )

      return part === undefined ? null : { threadId: waiting.thread.id, requestId: part.requestId }
    },
    OutsideQuestion: () => null,
    CheckIn: () => null,
    PullRequest: () => null,
    GlobalChat: () => null,
  })

export const summaryParts = (summary: string | null) => {
  if (summary === null) return null

  const [title = "", ...rest] = summary.split("\n")

  return { title, details: rest.join("\n").trim() }
}

export const titleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Thread: ({ thread }) => thread.name,
    OutsideQuestion: ({ question }) => question,
    CheckIn: ({ folder, summary }) => summaryParts(summary)?.title ?? fileName(folder),
    PullRequest: ({ pullRequest }) => pullRequest.title,
    GlobalChat: () => "Global chat",
  })

export const contextOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Thread: ({ thread }) => `${thread.repository.owner}/${thread.repository.repo}`,
    OutsideQuestion: ({ askedBy }) => `Asked by ${askedBy}`,
    CheckIn: ({ askedBy, folder }) => `${folder} · Asked by ${askedBy}`,
    GlobalChat: () => "",
    PullRequest: ({ pullRequest }) =>
      `${referenceText(pullRequest.ref)}${pullRequest.isDraft ? " · Draft" : ""}`,
  })

export function Waited(props: { since: DateTime.Utc; now: Date }) {
  const since = DateTime.toDateUtc(props.since)

  return (
    <time
      dateTime={since.toISOString()}
      className="shrink-0 text-xs text-muted-foreground tabular-nums"
    >
      <span className="sr-only">waiting </span>
      {ago(since, props.now)}
    </time>
  )
}

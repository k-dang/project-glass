import type {
  ConversationNeedsYou,
  NeedsYouGroup,
  NeedsYouItem,
  PullRequestReason,
  RequestPart,
  TurnEnding,
} from "@glass/contracts"
import { cn } from "cn"
import { Array as Arr, DateTime, Match, Predicate } from "effect"
import { CircleHelp, FileDiff, GitPullRequest, MessagesSquare, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { fileName } from "./fileName"
import { ago } from "./PullRequestRow"
import { warningTone } from "./status"
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
    finished: { label: "Conversations that finished", tone: "text-muted-foreground" },
  }

export const inboxKeys = ["E", "A"] as const

export interface InboxAction {
  readonly key: (typeof inboxKeys)[number]
  readonly label: string
  readonly run: () => void
}

interface Reason {
  readonly label: string
  readonly tone: Tone
}

const requestReason = (part: RequestPart): Reason =>
  Match.valueTags(part, {
    PermissionRequest: () => ({ label: "Permission request", tone: "warning" as const }),
    Question: () => ({ label: "Question", tone: "warning" as const }),
  })

const turnEndingReason = (ending: TurnEnding): Reason =>
  Match.valueTags(ending, {
    Done: () => ({ label: "Finished", tone: "neutral" as const }),
    Failed: () => ({ label: "Failed", tone: "danger" as const }),
    Stopped: () => ({ label: "Stopped", tone: "neutral" as const }),
    CutOff: () => ({ label: "Cut off", tone: "danger" as const }),
    Interrupted: () => ({ label: "Interrupted", tone: "neutral" as const }),
  })

export const conversationMarker = ({ reasons }: ConversationNeedsYou) => {
  const reason = reasons.find(Predicate.isTagged("WaitingRequests")) ?? reasons[0]

  return Match.valueTags(reason, {
    WaitingRequests: () => ({ label: "Waiting on you", tone: toneClass.warning }),
    TurnFinished: ({ ended }) => {
      const { label, tone } = turnEndingReason(ended.ending)

      return { label, tone: toneClass[tone] }
    },
  })
}

const pullRequestReason = (reason: PullRequestReason): Reason =>
  Match.valueTags(reason, {
    AgentReviewFinished: () => ({ label: "Agent review finished", tone: "review" as const }),
    ChangesRequested: () => ({ label: "Changes requested", tone: "danger" as const }),
    ChecksFailing: () => ({ label: "CI failing", tone: "danger" as const }),
    AwaitingReply: ({ threads }) => ({
      label: threads === 1 ? "1 thread awaiting reply" : `${threads} threads awaiting reply`,
      tone: "neutral" as const,
    }),
    ReadyToMerge: () => ({ label: "Ready to merge", tone: "success" as const }),
  })

const reasonsOf = (item: NeedsYouItem): ReadonlyArray<Reason> =>
  Arr.dedupeWith(
    Match.valueTags(item, {
      Conversation: ({ reasons }) =>
        reasons.flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map(requestReason),
            TurnFinished: ({ ended }) => [turnEndingReason(ended.ending)],
          }),
        ),
      OutsideQuestion: () => [{ label: "Question", tone: "warning" as const }],
      CheckIn: () => [{ label: "Check-in", tone: "warning" as const }],
      PullRequest: ({ reasons }) => reasons.map(pullRequestReason),
      GlobalConversation: ({ requests }) => requests.map(requestReason),
    }),
    (a, b) => a.label === b.label,
  )

export function Reasons(props: { item: NeedsYouItem }) {
  return reasonsOf(props.item).map((reason) => (
    <Badge
      key={reason.label}
      variant="outline"
      className={cn("rounded-sm px-1.5 font-normal", toneClass[reason.tone])}
    >
      {reason.label}
    </Badge>
  ))
}

export function ItemIcon(props: { item: NeedsYouItem; className: string }) {
  return Match.valueTags(props.item, {
    Conversation: () => <Sparkles className={props.className} aria-hidden />,
    OutsideQuestion: () => <CircleHelp className={props.className} aria-hidden />,
    CheckIn: () => <FileDiff className={props.className} aria-hidden />,
    PullRequest: () => <GitPullRequest className={props.className} aria-hidden />,
    GlobalConversation: () => <MessagesSquare className={props.className} aria-hidden />,
  })
}

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Conversation: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, {
          WaitingRequests: ({ requests }) => requests,
          TurnFinished: () => [],
        }),
      ),
    OutsideQuestion: () => [],
    CheckIn: () => [],
    PullRequest: () => [],
    GlobalConversation: ({ requests }) => requests,
  })

export const firstPermission = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Conversation: (waiting) => {
      const part = requestsOf(waiting).find((request) =>
        Predicate.isTagged(request, "PermissionRequest"),
      )

      return part === undefined
        ? null
        : { conversationId: waiting.conversation.id, requestId: part.requestId }
    },
    OutsideQuestion: () => null,
    CheckIn: () => null,
    PullRequest: () => null,
    GlobalConversation: () => null,
  })

export const summaryParts = (summary: string | null) => {
  if (summary === null) return null

  const [title = "", ...rest] = summary.split("\n")

  return { title, details: rest.join("\n").trim() }
}

export const titleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Conversation: ({ conversation }) => conversation.name,
    OutsideQuestion: ({ question }) => question,
    CheckIn: ({ folder, summary }) => summaryParts(summary)?.title ?? fileName(folder),
    PullRequest: ({ pullRequest }) => pullRequest.title,
    GlobalConversation: () => "Global conversation",
  })

export const contextOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Conversation: ({ conversation }) =>
      `${conversation.repository.owner}/${conversation.repository.repo}`,
    OutsideQuestion: ({ askedBy }) => `Asked by ${askedBy}`,
    CheckIn: ({ askedBy, folder }) => `${folder} · Asked by ${askedBy}`,
    GlobalConversation: () => "",
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

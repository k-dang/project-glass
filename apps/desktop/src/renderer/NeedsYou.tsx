import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type {
  AgentNeedsYou,
  AgentReason,
  NeedsYouItem,
  PullRequestNeedsYou,
  PullRequestReason,
  RequestPart,
} from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { DateTime, Match } from "effect"
import { AsyncResult } from "effect/reactivity"
import { GitPullRequest, Sparkles } from "lucide-react"
import { useMemo } from "react"
import { agentConversation, ConversationContext } from "./conversation"
import { Count } from "./Lists"
import { needsYouCountAtom, needsYouKey, needsYouStreamAtom, watchedNeedsYouAtom } from "./needsYou"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { RequestCard } from "./RequestCard"

const requestLabels: Record<RequestPart["_tag"], string> = {
  PermissionRequest: "Permission request",
  Question: "Question",
}

const pullRequestReasonLabels: Record<PullRequestReason["_tag"], string> = {
  ReviewRequested: "Review requested",
  AgentReviewFinished: "Agent review finished",
}

const agentReasonText = (reason: AgentReason): string =>
  Match.valueTags(reason, {
    WaitingRequests: ({ requests }) =>
      [...new Set(requests.map(({ _tag }) => requestLabels[_tag]))].join(" · "),
  })

const requestsOf = (reason: AgentReason): ReadonlyArray<RequestPart> =>
  Match.valueTags(reason, {
    WaitingRequests: ({ requests }) => requests,
  })

function Waited(props: { since: DateTime.Utc; now: Date }) {
  const since = DateTime.toDateUtc(props.since)

  return (
    <time
      dateTime={since.toISOString()}
      className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums"
    >
      <span className="sr-only">waiting </span>
      {ago(since, props.now)}
    </time>
  )
}

export function NeedsYouSummary() {
  const count = useAtomValue(needsYouCountAtom)
  const label = count === 0 ? "Nothing needs you" : `Needs you ${count}`

  return (
    <Link
      to="/inbox"
      className="flex h-10 items-center justify-between rounded-md border px-3 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">Inbox →</span>
    </Link>
  )
}

export function NeedsYouSection() {
  const result = useAtomValue(watchedNeedsYouAtom)
  const count = useAtomValue(needsYouCountAtom)
  const retry = useAtomRefresh(needsYouStreamAtom)

  return (
    <section aria-labelledby="needs-you-heading" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 id="needs-you-heading" className="text-base font-semibold">
          Needs you
        </h2>
        <Count count={count} />
      </div>
      <div className="border-t pt-1">
        {AsyncResult.builder(result)
          .onSuccess((items) =>
            items.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">Nothing needs you right now.</p>
            ) : (
              <ol aria-label="Needs you">
                <NeedsYouRows items={items} />
              </ol>
            ),
          )
          .onFailure((cause) => (
            <ProblemAlert problem={streamProblem(cause)} action={{ label: "Retry", run: retry }} />
          ))
          .orElse(() => (
            <output className="block py-2 text-sm text-muted-foreground">
              Loading what needs you…
            </output>
          ))}
      </div>
    </section>
  )
}

function NeedsYouRows(props: { items: ReadonlyArray<NeedsYouItem> }) {
  const now = new Date()

  return props.items.map((item) => <NeedsYouRow key={needsYouKey(item)} item={item} now={now} />)
}

function NeedsYouRow(props: { item: NeedsYouItem; now: Date }) {
  return Match.valueTags(props.item, {
    Agent: (item) => <AgentItem item={item} now={props.now} />,
    PullRequest: (item) => <PullRequestItem item={item} now={props.now} />,
  })
}

function AgentItem(props: { item: AgentNeedsYou; now: Date }) {
  const { agent, reasons, since } = props.item
  const conversation = useMemo(() => agentConversation(agent.id), [agent.id])

  return (
    <li className="flex flex-col gap-2 py-2">
      <div className="flex h-7 items-center gap-2.5 text-sm">
        <Sparkles className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className="min-w-0 truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {agent.name}
        </Link>
        <span className="text-xs text-muted-foreground">
          {reasons.map(agentReasonText).join(" · ")}
        </span>
        <Waited since={since} now={props.now} />
      </div>
      <ConversationContext value={conversation}>
        {reasons.flatMap(requestsOf).map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ConversationContext>
    </li>
  )
}

function PullRequestItem(props: { item: PullRequestNeedsYou; now: Date }) {
  const { pullRequest, reasons, since } = props.item

  return (
    <li>
      <Link
        to="/reviews/$owner/$repo/$number"
        params={pullRequest.ref}
        className="-mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        <GitPullRequest className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate">
          <span className="font-medium">{pullRequest.title}</span>{" "}
          <span className="text-xs text-muted-foreground">{referenceText(pullRequest.ref)}</span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {reasons.map(({ _tag }) => pullRequestReasonLabels[_tag]).join(" · ")}
        </span>
        <Waited since={since} now={props.now} />
      </Link>
    </li>
  )
}

export function NeedsYouBadge(props: { id: string }) {
  const count = useAtomValue(needsYouCountAtom)

  if (count === 0) return null

  return (
    <span
      id={props.id}
      className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums"
    >
      {count}
      <span className="sr-only"> need you</span>
    </span>
  )
}

import { useAtomValue } from "@effect/atom-react"
import type { NeedsYouItem, PullRequestNeedsYou, RequestPart } from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { GitPullRequest, Sparkles } from "lucide-react"
import { useMemo, useState } from "react"
import { agentConversation, ConversationContext } from "./conversation"
import { needsYouKey, watchedNeedsYouAtom } from "./needsYou"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { RequestCard } from "./RequestCard"

const reasonText = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons
        .flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map((part) => requestLabel(part)),
          }),
        )
        .filter((label, index, labels) => labels.indexOf(label) === index)
        .join(" · "),
    PullRequest: ({ reasons }) =>
      reasons.map((reason) => pullRequestLabel(reason._tag)).join(" · "),
  })

const requestLabel = (part: RequestPart) =>
  Match.valueTags(part, {
    PermissionRequest: () => "Permission request",
    Question: () => "Question",
  })

const pullRequestLabels = {
  ReviewRequested: "Review requested",
  AgentReviewFinished: "Agent review finished",
} as const satisfies Record<PullRequestNeedsYou["reasons"][number]["_tag"], string>

const pullRequestLabel = (tag: PullRequestNeedsYou["reasons"][number]["_tag"]) =>
  pullRequestLabels[tag]

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, { WaitingRequests: ({ requests }) => requests }),
      ),
    PullRequest: () => [],
  })

const sectionOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: () => "Stopped on you" as const,
    PullRequest: (pullRequest) =>
      pullRequest.reasons.some((reason) => Predicate.isTagged(reason, "ReviewRequested"))
        ? ("Holding up work" as const)
        : ("Waiting on you" as const),
  })

const sections = ["Stopped on you", "Holding up work", "Waiting on you"] as const

function Waited(props: { since: DateTime.Utc; now: Date }) {
  const since = DateTime.toDateUtc(props.since)

  return (
    <time dateTime={since.toISOString()} className="shrink-0 text-xs text-muted-foreground">
      {ago(since, props.now)}
    </time>
  )
}

export function Inbox() {
  const result = useAtomValue(watchedNeedsYouAtom)
  const items = Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<NeedsYouItem> => [])
  const [picked, setPicked] = useState<string | null>(null)
  const [now] = useState(() => new Date())

  const selectedKey = items.some((item) => needsYouKey(item) === picked)
    ? picked
    : items[0] && needsYouKey(items[0])

  const selected = items.find((item) => needsYouKey(item) === selectedKey) ?? null

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-80 shrink-0 flex-col border-r">
        <header className="flex items-baseline gap-2 border-b px-4 py-3">
          <h1 className="text-base font-semibold">Inbox</h1>
          <span className="text-xs text-muted-foreground">{items.length}</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {AsyncResult.isInitial(result) && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading what needs you…</p>
          )}
          {items.length === 0 && !AsyncResult.isInitial(result) && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
          )}
          {sections.map((title) => {
            const rows = items.filter((item) => sectionOf(item) === title)

            if (rows.length === 0) return null

            return (
              <section key={title} aria-label={title} className="py-2">
                <h2 className="px-4 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {title}
                </h2>
                <ul>
                  {rows.map((item) => (
                    <li key={needsYouKey(item)}>
                      <button
                        type="button"
                        aria-current={needsYouKey(item) === selectedKey ? "true" : undefined}
                        className={cn(
                          "flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent",
                        )}
                        onClick={() => setPicked(needsYouKey(item))}
                      >
                        <span className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {titleOf(item)}
                          </span>
                          <Waited since={item.since} now={now} />
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {subtitleOf(item)} · {reasonText(item)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        {selected === null ? (
          <p className="text-sm text-muted-foreground">Select something that needs you.</p>
        ) : (
          <InboxDetail item={selected} now={now} />
        )}
      </div>
    </div>
  )
}

const titleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent }) => agent.name,
    PullRequest: ({ pullRequest }) => pullRequest.title,
  })

const subtitleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `${agent.repository.owner}/${agent.repository.repo}`,
    PullRequest: ({ pullRequest }) =>
      `${referenceText(pullRequest.ref)}${pullRequest.isDraft ? " · Draft" : ""}`,
  })

function InboxDetail(props: { item: NeedsYouItem; now: Date }) {
  return Match.valueTags(props.item, {
    Agent: (item) => <AgentDetail item={item} now={props.now} />,
    PullRequest: (item) => <PullRequestDetail item={item} now={props.now} />,
  })
}

function AgentDetail(props: { item: Extract<NeedsYouItem, { _tag: "Agent" }>; now: Date }) {
  const { agent, since } = props.item
  const conversation = useMemo(() => agentConversation(agent.id), [agent.id])

  return (
    <article className="flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">{agent.name}</h2>
          <Waited since={since} now={props.now} />
        </div>
        <p className="text-sm text-muted-foreground">
          {agent.repository.owner}/{agent.repository.repo} · {reasonText(props.item)}
        </p>
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className="w-fit text-sm underline-offset-2 hover:underline"
        >
          Open the Agent
        </Link>
      </header>
      <ConversationContext value={conversation}>
        {requestsOf(props.item).map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ConversationContext>
    </article>
  )
}

function PullRequestDetail(props: { item: PullRequestNeedsYou; now: Date }) {
  const { pullRequest, since } = props.item

  return (
    <article className="flex max-w-2xl flex-col gap-3">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold">{pullRequest.title}</h2>
          <Waited since={since} now={props.now} />
        </div>
        <p className="text-sm text-muted-foreground">
          {referenceText(pullRequest.ref)} · {pullRequest.author}
          {pullRequest.isDraft ? " · Draft" : ""} · {reasonText(props.item)}
        </p>
      </header>
      <p className="text-sm">
        This pull request is waiting on you. Open it to review the diff, or leave it here until you
        do.
      </p>
      <Link
        to="/reviews/$owner/$repo/$number"
        params={pullRequest.ref}
        className="w-fit rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground"
      >
        Open pull request
      </Link>
    </article>
  )
}

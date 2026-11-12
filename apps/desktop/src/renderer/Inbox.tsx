import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  type NeedsYouItem,
  type PullRequestNeedsYou,
  type RequestPart,
  referenceKey,
} from "@glass/contracts"
import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match, Option, Predicate } from "effect"
import { GitPullRequest, Sparkles } from "lucide-react"
import { useMemo, useState } from "react"
import { Kbd } from "@/components/ui/kbd"
import { AgentRequest, answerRequestAtom } from "./agentsArea"
import { agentConversation, ConversationContext } from "./conversation"
import {
  needsYouCount,
  needsYouKey,
  needsYouStatus,
  NeedsYouStatus,
  needsYouStreamAtom,
  watchedNeedsYouAtom,
} from "./needsYou"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { readAgentReviewOnOpenAtom } from "./reviewsArea"
import { RequestCard } from "./RequestCard"
import { useShortcuts } from "./useShortcuts"

const sections = [
  { id: "stopped", title: "Stopped on you" },
  { id: "holding", title: "Holding up work" },
  { id: "waiting", title: "Waiting on you" },
] as const

type SectionId = (typeof sections)[number]["id"]

const requestLabel = (part: RequestPart) =>
  Match.valueTags(part, {
    PermissionRequest: () => "Permission request",
    Question: () => "Question",
  })

const pullRequestReasonLabels = {
  ReviewRequested: "Review requested",
  AgentReviewFinished: "Agent review finished",
} as const satisfies Record<PullRequestNeedsYou["reasons"][number]["_tag"], string>

const sectionOf = (item: NeedsYouItem): SectionId =>
  Match.valueTags(item, {
    Agent: (): SectionId => "stopped",
    PullRequest: (pullRequest): SectionId =>
      pullRequest.reasons.some((reason) => Predicate.isTagged(reason, "ReviewRequested"))
        ? "holding"
        : "waiting",
  })

const reasonText = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons
        .flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map(requestLabel),
          }),
        )
        .filter((label, index, labels) => labels.indexOf(label) === index)
        .join(" · "),
    PullRequest: ({ reasons }) =>
      reasons.map((reason) => pullRequestReasonLabels[reason._tag]).join(" · "),
  })

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, { WaitingRequests: ({ requests }) => requests }),
      ),
    PullRequest: () => [],
  })

const firstPermission = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: (agent) => {
      const part = requestsOf(agent).find((request) =>
        Predicate.isTagged(request, "PermissionRequest"),
      )

      return part === undefined ? null : { agentId: agent.agent.id, requestId: part.requestId }
    },
    PullRequest: () => null,
  })

const finishedReview = (item: PullRequestNeedsYou) =>
  item.reasons.some((reason) => Predicate.isTagged(reason, "AgentReviewFinished"))

const nextRemaining = (
  previous: readonly string[],
  current: string | null,
  next: readonly string[],
): string | null => {
  if (next.length === 0) return null

  if (current !== null && next.includes(current)) return current

  if (current === null) return next[0] ?? null

  const at = previous.indexOf(current)
  const later = at === -1 ? undefined : previous.slice(at + 1).find((key) => next.includes(key))

  if (later !== undefined) return later

  const earlier = previous
    .slice(0, Math.max(at, 0))
    .toReversed()
    .find((key) => next.includes(key))

  return earlier ?? next[0] ?? null
}

const titleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent }) => agent.name,
    PullRequest: ({ pullRequest }) => pullRequest.title,
  })

function Waited(props: { since: DateTime.Utc; now: Date }) {
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

function InboxCount(props: { status: NeedsYouStatus }) {
  const count = needsYouCount(props.status)

  if (Option.isNone(count)) return null

  return <span className="font-normal text-muted-foreground">{count.value}</span>
}

function InboxRows(props: {
  status: NeedsYouStatus
  selectedKey: string | null
  now: Date
  onRetry: () => void
  onPick: (key: string) => void
}) {
  return NeedsYouStatus.$match(props.status, {
    Loading: () => (
      <output className="block px-4 py-3 text-sm text-muted-foreground">
        Loading what needs you…
      </output>
    ),
    Failed: ({ cause }) => (
      <div className="px-4 py-3">
        <ProblemAlert
          problem={streamProblem(cause)}
          action={{ label: "Retry", run: props.onRetry }}
        />
      </div>
    ),
    Ready: ({ items }) =>
      items.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
      ) : (
        <InboxSections
          items={items}
          selectedKey={props.selectedKey}
          now={props.now}
          onPick={props.onPick}
        />
      ),
  })
}

function InboxSections(props: {
  items: ReadonlyArray<NeedsYouItem>
  selectedKey: string | null
  now: Date
  onPick: (key: string) => void
}) {
  return sections.map((section) => {
    const rows = props.items.filter((item) => sectionOf(item) === section.id)

    if (rows.length === 0) return null

    return (
      <section key={section.id} aria-label={section.title} className="py-2">
        <h2 className="px-4 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {section.title}
        </h2>
        <ul>
          {rows.map((item) => {
            const key = needsYouKey(item)

            return (
              <li key={key}>
                <button
                  type="button"
                  aria-current={key === props.selectedKey ? "true" : undefined}
                  className="flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent"
                  onClick={() => props.onPick(key)}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 font-medium" title={titleOf(item)}>
                      {titleOf(item)}
                    </span>
                    <Waited since={item.since} now={props.now} />
                  </span>
                  <span className="text-pretty text-xs text-muted-foreground" title={lineOf(item)}>
                    {lineOf(item)}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </section>
    )
  })
}

function InboxPane(props: {
  status: NeedsYouStatus
  selected: NeedsYouItem | null
  now: Date
  onReadReview: (pullRequest: string) => void
}) {
  return NeedsYouStatus.$match(props.status, {
    Loading: () => null,
    Failed: () => null,
    Ready: ({ items }) =>
      props.selected === null ? (
        <p className="text-sm text-muted-foreground">
          {items.length === 0 ? "Nothing needs you right now." : "Select something that needs you."}
        </p>
      ) : (
        <InboxDetail item={props.selected} now={props.now} onReadReview={props.onReadReview} />
      ),
  })
}

export function Inbox() {
  const status = needsYouStatus(useAtomValue(watchedNeedsYouAtom))
  const retry = useAtomRefresh(needsYouStreamAtom)
  const navigate = useNavigate()
  const markReview = useAtomSet(readAgentReviewOnOpenAtom)

  const items = NeedsYouStatus.$match(status, {
    Loading: (): ReadonlyArray<NeedsYouItem> => [],
    Failed: (): ReadonlyArray<NeedsYouItem> => [],
    Ready: ({ items: ready }) => ready,
  })

  const flat = sections.flatMap((section) => items.filter((item) => sectionOf(item) === section.id))
  const keys = flat.map(needsYouKey)
  const order = keys.join("\n")
  const [picked, setPicked] = useState<string | null>(null)

  const [seen, setSeen] = useState<{ order: string; keys: readonly string[] }>({
    order,
    keys,
  })

  const [now] = useState(() => new Date())

  if (seen.order !== order) {
    const resolved = nextRemaining(seen.keys, picked, keys)
    setSeen({ order, keys })

    if (resolved !== picked) setPicked(resolved)
  }

  const selectedKey = nextRemaining(seen.order === order ? seen.keys : keys, picked, keys)
  const selected = flat.find((item) => needsYouKey(item) === selectedKey) ?? null
  const permission = selected === null ? null : firstPermission(selected)

  const allow = useAtomSet(
    answerRequestAtom(
      new AgentRequest({
        agentId: permission?.agentId ?? "",
        requestId: permission?.requestId ?? "",
      }),
    ),
  )

  const openSelected = () => {
    if (selected === null) return

    Match.valueTags(selected, {
      Agent: ({ agent }) =>
        void navigate({ to: "/agents/$agentId", params: { agentId: agent.id } }),
      PullRequest: ({ pullRequest }) =>
        void navigate({ to: "/reviews/$owner/$repo/$number", params: pullRequest.ref }),
    })
  }

  const move = (delta: number) => {
    if (selectedKey === null) return

    const at = keys.indexOf(selectedKey)
    const next = keys[Math.min(keys.length - 1, Math.max(0, at + delta))]

    if (next !== undefined) setPicked(next)
  }

  useShortcuts([
    { key: "j", run: () => move(1) },
    { key: "k", run: () => move(-1) },
    { key: "Enter", skipOnControl: true, run: openSelected },
    {
      key: "a",
      run: () => {
        if (permission !== null) allow(AllowRequest.make({}))
      },
    },
  ])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-96 shrink-0 flex-col border-r">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <h1 className="text-base font-semibold">
            Inbox <InboxCount status={status} />
          </h1>
          <p className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <Kbd>J</Kbd>
              <Kbd>K</Kbd>
              move
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Kbd>Enter</Kbd>
              open
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Kbd>A</Kbd>
              allow
            </span>
          </p>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <InboxRows
            status={status}
            selectedKey={selectedKey}
            now={now}
            onRetry={retry}
            onPick={setPicked}
          />
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <InboxPane status={status} selected={selected} now={now} onReadReview={markReview} />
      </div>
    </div>
  )
}

const lineOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: (agent) =>
      `${agent.agent.repository.owner}/${agent.agent.repository.repo} · ${reasonText(agent)}`,
    PullRequest: (pullRequest) =>
      [
        referenceText(pullRequest.pullRequest.ref),
        pullRequest.pullRequest.isDraft ? "Draft" : null,
        reasonText(pullRequest),
      ]
        .filter((part) => part !== null)
        .join(" · "),
  })

function InboxDetail(props: {
  item: NeedsYouItem
  now: Date
  onReadReview: (pullRequest: string) => void
}) {
  return Match.valueTags(props.item, {
    Agent: (item) => <AgentDetail item={item} now={props.now} />,
    PullRequest: (item) => (
      <PullRequestDetail item={item} now={props.now} onReadReview={props.onReadReview} />
    ),
  })
}

const actionLink =
  "inline-flex h-8 items-center rounded-md px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"

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
        <p className="text-sm text-pretty text-muted-foreground">
          {agent.repository.owner}/{agent.repository.repo} · {reasonText(props.item)}
        </p>
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className={cn(actionLink, "w-fit bg-primary text-primary-foreground")}
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

function PullRequestDetail(props: {
  item: PullRequestNeedsYou
  now: Date
  onReadReview: (pullRequest: string) => void
}) {
  const { pullRequest, since } = props.item
  const updated = DateTime.toDateUtc(pullRequest.updatedAt)

  return (
    <article className="flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <GitPullRequest className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold text-pretty">{pullRequest.title}</h2>
          <Waited since={since} now={props.now} />
        </div>
        <p className="text-sm text-pretty text-muted-foreground">
          {referenceText(pullRequest.ref)} · {pullRequest.author}
          {pullRequest.isDraft ? " · Draft" : ""} · Updated {ago(updated, props.now)}
        </p>
        <p className="text-sm text-pretty">{reasonText(props.item)}</p>
      </header>
      <div className="flex flex-wrap gap-2">
        <Link
          to="/reviews/$owner/$repo/$number"
          params={pullRequest.ref}
          className={cn(actionLink, "bg-primary text-primary-foreground")}
        >
          Open pull request
        </Link>
        {finishedReview(props.item) && (
          <Link
            to="/reviews/$owner/$repo/$number"
            params={pullRequest.ref}
            className={cn(actionLink, "border")}
            onClick={() => props.onReadReview(referenceKey(pullRequest.ref))}
          >
            Read Agent review
          </Link>
        )}
      </div>
    </article>
  )
}

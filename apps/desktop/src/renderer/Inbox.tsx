import { useAtomValue } from "@effect/atom-react"
import type { NeedsYouItem, PullRequestNeedsYou, RequestPart } from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { GitPullRequest, Sparkles } from "lucide-react"
import { type ReactNode, useMemo, useState } from "react"
import { agentConversation, ConversationContext } from "./conversation"
import { needsYouKey, watchedNeedsYouAtom } from "./needsYou"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { RequestCard } from "./RequestCard"

const kinds = [
  { id: "all", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "pull-requests", label: "Pull requests" },
] as const

type Kind = (typeof kinds)[number]["id"]

const projectOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent }) => `${agent.repository.owner}/${agent.repository.repo}`,
    PullRequest: ({ pullRequest }) => `${pullRequest.ref.owner}/${pullRequest.ref.repo}`,
  })

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
      reasons.map((reason) => pullRequestLabels[reason._tag]).join(" · "),
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

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, { WaitingRequests: ({ requests }) => requests }),
      ),
    PullRequest: () => [],
  })

const matchesKind = (item: NeedsYouItem, kind: Kind) =>
  kind === "all" ||
  (kind === "agents" && Predicate.isTagged(item, "Agent")) ||
  (kind === "pull-requests" && Predicate.isTagged(item, "PullRequest"))

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
  const [project, setProject] = useState("all")
  const [kind, setKind] = useState<Kind>("all")
  const [picked, setPicked] = useState<string | null>(null)
  const [now] = useState(() => new Date())
  const projects = [...new Set(items.map(projectOf))].toSorted()

  const visible = items.filter(
    (item) => (project === "all" || projectOf(item) === project) && matchesKind(item, kind),
  )

  const selectedKey = visible.some((item) => needsYouKey(item) === picked)
    ? picked
    : visible[0] && needsYouKey(visible[0])

  const selected = visible.find((item) => needsYouKey(item) === selectedKey) ?? null

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="flex w-52 shrink-0 flex-col gap-4 overflow-y-auto border-r px-2 py-3">
        <FilterGroup label="Projects">
          <FilterRow
            label="All"
            count={items.length}
            current={project === "all"}
            onSelect={() => setProject("all")}
          />
          {projects.map((name) => (
            <FilterRow
              key={name}
              label={name}
              count={items.filter((item) => projectOf(item) === name).length}
              current={project === name}
              onSelect={() => setProject(name)}
            />
          ))}
        </FilterGroup>
        <FilterGroup label="Kind">
          {kinds.map((entry) => (
            <FilterRow
              key={entry.id}
              label={entry.label}
              count={items.filter((item) => matchesKind(item, entry.id)).length}
              current={kind === entry.id}
              onSelect={() => setKind(entry.id)}
            />
          ))}
        </FilterGroup>
      </aside>
      <div className="flex w-80 shrink-0 flex-col border-r">
        <header className="border-b px-4 py-3 text-sm font-semibold">
          {project === "all" ? "All projects" : project}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {AsyncResult.isInitial(result) && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Loading what needs you…</p>
          )}
          {visible.length === 0 && !AsyncResult.isInitial(result) && (
            <p className="px-4 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
          )}
          <ul>
            {visible.map((item) => (
              <li key={needsYouKey(item)}>
                <button
                  type="button"
                  aria-current={needsYouKey(item) === selectedKey ? "true" : undefined}
                  className="flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent"
                  onClick={() => setPicked(needsYouKey(item))}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{titleOf(item)}</span>
                    <Waited since={item.since} now={now} />
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {project === "all" ? `${projectOf(item)} · ` : ""}
                    {reasonText(item)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
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

function FilterGroup(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h2 className="px-2 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.label}
      </h2>
      {props.children}
    </div>
  )
}

function FilterRow(props: {
  label: string
  count: number
  current: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      aria-current={props.current ? "true" : undefined}
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent",
      )}
      onClick={props.onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{props.label}</span>
      <span className="text-xs text-muted-foreground tabular-nums">{props.count}</span>
    </button>
  )
}

const titleOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent }) => agent.name,
    PullRequest: ({ pullRequest }) => pullRequest.title,
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
          {projectOf(props.item)} · {reasonText(props.item)}
        </p>
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

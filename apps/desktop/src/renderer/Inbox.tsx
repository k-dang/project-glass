import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { AllowRequest, type NeedsYouItem, type RequestPart } from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match, Option, Predicate } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useMemo, useState } from "react"
import { AgentRequest, answerRequestAtom } from "./agentsArea"
import { agentConversation, ConversationContext } from "./conversation"
import { needsYouKey, watchedNeedsYouAtom } from "./needsYou"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { RequestCard } from "./RequestCard"
import { useShortcuts } from "./useShortcuts"

const labelOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ agent, reasons }) =>
      `${agent.name} · ${agent.repository.owner}/${agent.repository.repo} · ${reasons
        .flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map((part) => requestLabel(part)),
          }),
        )
        .filter((label, index, labels) => labels.indexOf(label) === index)
        .join(" · ")}`,
    PullRequest: ({ pullRequest, reasons }) =>
      `${pullRequest.title} · ${referenceText(pullRequest.ref)} · ${reasons
        .map((reason) =>
          Match.valueTags(reason, {
            ReviewRequested: () => "Review requested",
            AgentReviewFinished: () => "Agent review finished",
          }),
        )
        .join(" · ")}`,
  })

const requestLabel = (part: RequestPart) =>
  Match.valueTags(part, {
    PermissionRequest: () => "Permission",
    Question: () => "Question",
  })

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, { WaitingRequests: ({ requests }) => requests }),
      ),
    PullRequest: () => [],
  })

const firstPermission = (item: NeedsYouItem | undefined) => {
  if (item === undefined) return null

  return Match.valueTags(item, {
    Agent: (agent) => {
      const part = requestsOf(agent).find((request) =>
        Predicate.isTagged(request, "PermissionRequest"),
      )

      return part === undefined ? null : { agentId: agent.agent.id, requestId: part.requestId }
    },
    PullRequest: () => null,
  })
}

export function Inbox() {
  const result = useAtomValue(watchedNeedsYouAtom)
  const items = Option.getOrElse(AsyncResult.value(result), (): ReadonlyArray<NeedsYouItem> => [])
  const [cursor, setCursor] = useState(0)
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [now] = useState(() => new Date())
  const index = items.length === 0 ? 0 : Math.min(cursor, items.length - 1)
  const selected = items[index]
  const selectedKey = selected ? needsYouKey(selected) : null
  const permission = firstPermission(selected)

  const allow = useAtomSet(
    answerRequestAtom(
      new AgentRequest({
        agentId: permission?.agentId ?? "",
        requestId: permission?.requestId ?? "",
      }),
    ),
  )

  useShortcuts([
    {
      key: "j",
      run: () => {
        setOpenKey(null)
        setCursor((current) => Math.min(items.length - 1, current + 1))
      },
    },
    {
      key: "k",
      run: () => {
        setOpenKey(null)
        setCursor((current) => Math.max(0, current - 1))
      },
    },
    {
      key: "Enter",
      run: () => {
        if (selectedKey === null) return

        setOpenKey((current) => (current === selectedKey ? null : selectedKey))
      },
    },
    {
      key: "a",
      run: () => {
        if (permission) allow(AllowRequest.make({}))
      },
    },
  ])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-baseline justify-between border-b px-4 py-2">
        <h1 className="text-sm font-semibold">
          Inbox <span className="font-normal text-muted-foreground">{items.length}</span>
        </h1>
        <p className="text-xs text-muted-foreground">j/k move · enter open · a allow</p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {AsyncResult.isInitial(result) && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Loading what needs you…</p>
        )}
        {items.length === 0 && !AsyncResult.isInitial(result) && (
          <p className="px-4 py-3 text-sm text-muted-foreground">Nothing needs you right now.</p>
        )}
        <ol aria-label="Inbox">
          {items.map((item, row) => {
            const key = needsYouKey(item)
            const current = key === selectedKey
            const open = key === openKey

            return (
              <li key={key} className={cn(current && "bg-accent")}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  aria-expanded={open}
                  className="flex h-8 w-full items-center gap-3 px-4 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => {
                    setCursor(row)
                    setOpenKey((existing) => (existing === key ? null : key))
                  }}
                >
                  <span className="w-8 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {row + 1}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{labelOf(item)}</span>
                  <time
                    dateTime={DateTime.toDateUtc(item.since).toISOString()}
                    className="shrink-0 text-xs text-muted-foreground tabular-nums"
                  >
                    {ago(DateTime.toDateUtc(item.since), now)}
                  </time>
                </button>
                {open && <InboxAnswer item={item} />}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

function InboxAnswer(props: { item: NeedsYouItem }) {
  return Match.valueTags(props.item, {
    Agent: (item) => <AgentAnswer item={item} />,
    PullRequest: (item) => (
      <div className="flex items-center gap-3 px-4 pb-3 pl-16 text-sm">
        <span className="text-muted-foreground">
          {item.pullRequest.author}
          {item.pullRequest.isDraft ? " · Draft" : ""}
        </span>
        <Link
          to="/reviews/$owner/$repo/$number"
          params={item.pullRequest.ref}
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground"
        >
          Open pull request
        </Link>
      </div>
    ),
  })
}

function AgentAnswer(props: { item: Extract<NeedsYouItem, { _tag: "Agent" }> }) {
  const conversation = useMemo(() => agentConversation(props.item.agent.id), [props.item.agent.id])

  return (
    <div className="flex flex-col gap-2 px-4 pb-3 pl-16">
      <ConversationContext value={conversation}>
        {requestsOf(props.item).map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ConversationContext>
    </div>
  )
}

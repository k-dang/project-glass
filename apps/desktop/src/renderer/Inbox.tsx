import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  OutsideChoice,
  OutsideText,
  type NeedsYouItem,
  type OutsideQuestion,
  type OutsideQuestionAnswer,
  type PullRequestNeedsYou,
  type RequestPart,
  referenceKey,
} from "@glass/contracts"
import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { DateTime, Match, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { CircleHelp, GitPullRequest, Sparkles } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Backend, backendRuntime } from "./backend"
import { AgentRequest, answerRequestAtom } from "./agentsArea"
import { agentConversation, ConversationContext } from "./conversation"
import {
  needsYouCount,
  needsYouKey,
  type NeedsYouResult,
  needsYouStreamAtom,
  watchedNeedsYouAtom,
} from "./needsYou"
import { ProblemAlert } from "./ProblemAlert"
import { settledProblem, streamProblem } from "./problems"
import { ago } from "./PullRequestRow"
import { referenceText } from "./queue"
import { readAgentReviewOnOpenAtom } from "./reviewsArea"
import { RequestCard } from "./RequestCard"
import { useShortcuts } from "./useShortcuts"

const inStopped = (item: NeedsYouItem) =>
  Predicate.isTagged(item, "Agent") || Predicate.isTagged(item, "OutsideQuestion")

const inWaiting = (item: NeedsYouItem) => Predicate.isTagged(item, "PullRequest")

const sections = [
  { id: "stopped", title: "Stopped on you", include: inStopped },
  { id: "waiting", title: "Waiting on you", include: inWaiting },
] as const

const requestLabel = (part: RequestPart) =>
  Match.valueTags(part, {
    PermissionRequest: () => "Permission request",
    Question: () => "Question",
  })

const pullRequestReasonLabels = {
  AgentReviewFinished: "Agent review finished",
} as const satisfies Record<PullRequestNeedsYou["reasons"][number]["_tag"], string>

const askedBy = (question: OutsideQuestion) => question.label ?? "An agent"

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
    OutsideQuestion: (question) => `Asked by ${askedBy(question)}`,
    PullRequest: ({ reasons }) =>
      reasons.map((reason) => pullRequestReasonLabels[reason._tag]).join(" · "),
  })

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, { WaitingRequests: ({ requests }) => requests }),
      ),
    OutsideQuestion: () => [],
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
    OutsideQuestion: () => null,
    PullRequest: () => null,
  })

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
    OutsideQuestion: ({ question }) => question,
    PullRequest: ({ pullRequest }) => pullRequest.title,
  })

const minute = 60_000

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), minute)

    return () => window.clearInterval(timer)
  }, [])

  return now
}

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

function InboxCount(props: { status: NeedsYouResult }) {
  const count = needsYouCount(props.status)

  if (Option.isNone(count)) return null

  return <span className="font-normal text-muted-foreground">{count.value}</span>
}

function InboxRows(props: {
  status: NeedsYouResult
  selectedKey: string | null
  now: Date
  onRetry: () => void
  onPick: (key: string) => void
}) {
  return AsyncResult.match(props.status, {
    onInitial: () => (
      <output className="block px-4 py-3 text-sm text-muted-foreground">
        Loading what needs you…
      </output>
    ),
    onFailure: ({ cause }) => (
      <div className="px-4 py-3">
        <ProblemAlert
          problem={streamProblem(cause)}
          action={{ label: "Retry", run: props.onRetry }}
        />
      </div>
    ),
    onSuccess: ({ value: items }) =>
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
    const rows = props.items.filter(section.include)

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
                  data-inbox-row={key}
                  aria-current={key === props.selectedKey ? "true" : undefined}
                  className="flex w-full flex-col gap-0.5 px-4 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent"
                  onClick={() => props.onPick(key)}
                >
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 flex-1 font-medium break-words" title={titleOf(item)}>
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
  status: NeedsYouResult
  selected: NeedsYouItem | null
  now: Date
  onReadReview: (pullRequest: string) => void
}) {
  return AsyncResult.match(props.status, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value: items }) =>
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
  const status = useAtomValue(watchedNeedsYouAtom)
  const now = useMinuteClock()
  const retry = useAtomRefresh(needsYouStreamAtom)

  const navigate = useNavigate()
  const markReview = useAtomSet(readAgentReviewOnOpenAtom)

  const items = AsyncResult.isSuccess(status) ? status.value : []

  const flat = sections.flatMap((section) => items.filter(section.include))
  const keys = flat.map(needsYouKey)
  const order = keys.join("\n")
  const [picked, setPicked] = useState<string | null>(null)

  const [seen, setSeen] = useState<{ order: string; keys: readonly string[] }>({
    order,
    keys,
  })

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
      OutsideQuestion: () => undefined,
      PullRequest: ({ pullRequest }) =>
        void navigate({ to: "/reviews/$owner/$repo/$number", params: pullRequest.ref }),
    })
  }

  const move = (delta: number) => {
    if (selectedKey === null) return

    const at = keys.indexOf(selectedKey)
    const next = keys[Math.min(keys.length - 1, Math.max(0, at + delta))]

    if (next === undefined) return

    setPicked(next)
    document.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(next)}"]`)?.focus()
  }

  useShortcuts([
    { key: "j", run: () => move(1) },
    { key: "k", run: () => move(-1) },
    {
      key: "Enter",
      skipOnControl: true,
      except: "[data-inbox-row]",
      run: openSelected,
    },
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
    OutsideQuestion: (question) => reasonText(question),
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
    OutsideQuestion: (item) => <OutsideQuestionDetail item={item} now={props.now} />,
    PullRequest: (item) => (
      <PullRequestDetail item={item} now={props.now} onReadReview={props.onReadReview} />
    ),
  })
}

const answerOutsideQuestionAtom = Atom.family((id: string) =>
  backendRuntime.fn((answer: OutsideQuestionAnswer) =>
    Backend.use((backend) => backend.AnswerOutsideQuestion({ id, answer })),
  ),
)

function OutsideQuestionDetail(props: { item: OutsideQuestion; now: Date }) {
  const { item } = props
  const answering = answerOutsideQuestionAtom(item.id)
  const sent = useAtomValue(answering)
  const answer = useAtomSet(answering)
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState("")
  const textId = useId()
  const choicesId = useId()
  const typed = text.trim()
  const problem = settledProblem(sent)
  const textLabel = item.choices.length > 0 ? "Or type an answer" : "Your answer"

  const submit = () => {
    if (typed !== "") answer(OutsideText.make({ text: typed }))
    else if (choice !== null) answer(OutsideChoice.make({ choice }))
  }

  return (
    <article className="flex max-w-2xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <CircleHelp className="size-4 text-muted-foreground" aria-hidden />
          <h2 className="text-lg font-semibold text-pretty break-words">{item.question}</h2>
          <Waited since={item.since} now={props.now} />
        </div>
        <p className="text-sm text-pretty text-muted-foreground">Asked by {askedBy(item)}</p>
      </header>
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {item.choices.length > 0 && (
          <RadioGroup<string | null>
            aria-labelledby={choicesId}
            value={choice}
            onValueChange={setChoice}
          >
            <span id={choicesId} className="sr-only">
              Choices
            </span>
            {item.choices.map((label) => (
              <Label key={label} className="flex items-start gap-2 font-normal">
                <RadioGroupItem value={label} />
                <span>{label}</span>
              </Label>
            ))}
          </RadioGroup>
        )}
        <Label htmlFor={textId} className="sr-only">
          {textLabel}
        </Label>
        <Input
          id={textId}
          placeholder={textLabel}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={sent.waiting || (typed === "" && choice === null)}>
            Send
          </Button>
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>Enter</Kbd>
            sends
          </p>
        </div>
        {problem !== null && (
          <p role="alert" className="text-xs text-destructive">
            {problem.detail}
          </p>
        )}
      </form>
    </article>
  )
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
        <Link
          to="/reviews/$owner/$repo/$number"
          params={pullRequest.ref}
          className={cn(actionLink, "border")}
          onClick={() => props.onReadReview(referenceKey(pullRequest.ref))}
        >
          Read Agent review
        </Link>
      </div>
    </article>
  )
}

import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  OutsideChoice,
  OutsideText,
  type NeedsYouItem,
  type OutsideQuestion,
  type OutsideQuestionAnswer,
  type PullRequestNeedsYou,
  type PullRequestReason,
  type RequestPart,
  referenceKey,
  stopsOnYou,
  type TurnEnding,
} from "@glass/contracts"
import { Link, useNavigate } from "@tanstack/react-router"
import { cn } from "cn"
import { Array as Arr, DateTime, Match, Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  CircleHelp,
  GitPullRequest,
  Inbox as InboxIcon,
  MessagesSquare,
  Sparkles,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Backend, backendRuntime } from "./backend"
import { AgentRequest, answerRequestAtom } from "./agentsArea"
import { agentConversation, ConversationContext } from "./conversation"
import { globalConversation, globalConversationOpenAtom } from "./globalConversation"
import {
  finishedAgentReviewOf,
  markDoneAtom,
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

const sections: ReadonlyArray<{
  readonly title: string
  readonly stopped: boolean
}> = [
  { title: "Stopped on you", stopped: true },
  { title: "Waiting on you", stopped: false },
]

const inSection = (section: (typeof sections)[number]) => (item: NeedsYouItem) =>
  stopsOnYou(item) === section.stopped

const requestLabel = (part: RequestPart) =>
  Match.valueTags(part, {
    PermissionRequest: () => "Permission request",
    Question: () => "Question",
  })

const labelsText = (labels: ReadonlyArray<string>) => Arr.dedupe(labels).join(" · ")

const turnEndingLabel = (ending: TurnEnding) =>
  Match.valueTags(ending, {
    Done: () => "Finished",
    Failed: () => "Failed",
    Stopped: () => "Stopped",
    CutOff: () => "Cut off",
    Interrupted: () => "Interrupted",
  })

const pullRequestReasonLabel = (reason: PullRequestReason) =>
  Match.valueTags(reason, {
    AgentReviewFinished: () => "Agent review finished",
    ChangesRequested: () => "Changes requested",
    ChecksFailing: () => "CI failing",
    AwaitingReply: ({ threads }) =>
      threads === 1 ? "1 thread awaiting reply" : `${threads} threads awaiting reply`,
    ReadyToMerge: () => "Ready to merge",
  })

const reasonText = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      labelsText(
        reasons.flatMap((reason) =>
          Match.valueTags(reason, {
            WaitingRequests: ({ requests }) => requests.map(requestLabel),
            TurnFinished: ({ ended }) => [turnEndingLabel(ended.ending)],
          }),
        ),
      ),
    OutsideQuestion: ({ askedBy }) => `Asked by ${askedBy}`,
    PullRequest: ({ reasons }) => reasons.map(pullRequestReasonLabel).join(" · "),
    GlobalConversation: ({ requests }) => labelsText(requests.map(requestLabel)),
  })

const requestsOf = (item: NeedsYouItem): ReadonlyArray<RequestPart> =>
  Match.valueTags(item, {
    Agent: ({ reasons }) =>
      reasons.flatMap((reason) =>
        Match.valueTags(reason, {
          WaitingRequests: ({ requests }) => requests,
          TurnFinished: () => [],
        }),
      ),
    OutsideQuestion: () => [],
    PullRequest: () => [],
    GlobalConversation: ({ requests }) => requests,
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
    GlobalConversation: () => null,
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
    GlobalConversation: () => "Global conversation",
  })

function KindIcon(props: { item: NeedsYouItem; className: string }) {
  const icon = { className: props.className, "aria-hidden": true }

  return Match.valueTags(props.item, {
    Agent: () => <Sparkles {...icon} />,
    OutsideQuestion: () => <CircleHelp {...icon} />,
    PullRequest: () => <GitPullRequest {...icon} />,
    GlobalConversation: () => <MessagesSquare {...icon} />,
  })
}

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
    const rows = props.items.filter(inSection(section))

    if (rows.length === 0) return null

    return (
      <section key={section.title} aria-label={section.title} className="py-2">
        <h2 className="px-4 py-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {section.title}
        </h2>
        <ul className="px-2">
          {rows.map((item) => {
            const key = needsYouKey(item)

            return (
              <li key={key}>
                <button
                  type="button"
                  data-inbox-row={key}
                  aria-current={key === props.selectedKey ? "true" : undefined}
                  className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent"
                  onClick={() => props.onPick(key)}
                >
                  <KindIcon item={item} className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-baseline gap-2">
                      <span
                        className="min-w-0 flex-1 font-medium break-words"
                        title={titleOf(item)}
                      >
                        {titleOf(item)}
                      </span>
                      <Waited since={item.since} now={props.now} />
                    </span>
                    <span
                      className="text-pretty text-xs text-muted-foreground"
                      title={lineOf(item)}
                    >
                      {lineOf(item)}
                    </span>
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
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <span className="flex size-10 items-center justify-center rounded-full border bg-muted/50 text-muted-foreground">
            <InboxIcon className="size-5" aria-hidden />
          </span>
          <p className="text-sm text-muted-foreground">
            {items.length === 0
              ? "Nothing needs you right now."
              : "Select something that needs you."}
          </p>
        </div>
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
  const markDone = useAtomSet(markDoneAtom)
  const openGlobal = useAtomSet(globalConversationOpenAtom)

  const items = AsyncResult.isSuccess(status) ? status.value : []

  const flat = sections.flatMap((section) => items.filter(inSection(section)))
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
      GlobalConversation: () => openGlobal(true),
    })
  }

  useShortcuts([
    {
      key: "Enter",
      skipOnControl: true,
      except: "[data-inbox-row]",
      run: openSelected,
    },
    {
      key: "e",
      run: () => {
        if (!Predicate.isTagged(selected, "PullRequest")) return

        const review = finishedAgentReviewOf(selected)

        if (review !== undefined) {
          markDone({ pullRequest: selected.pullRequest.ref, writtenAt: review.writtenAt })
        }
      },
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
              <Kbd>Enter</Kbd>
              open
            </span>
            <span aria-hidden>·</span>
            <span className="inline-flex items-center gap-1">
              <Kbd>E</Kbd>
              done
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
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col px-8 py-10">
          <InboxPane status={status} selected={selected} now={now} onReadReview={markReview} />
        </div>
      </div>
    </div>
  )
}

const lineOf = (item: NeedsYouItem) =>
  Match.valueTags(item, {
    Agent: (agent) =>
      `${agent.agent.repository.owner}/${agent.agent.repository.repo} · ${reasonText(agent)}`,
    OutsideQuestion: (question) => reasonText(question),
    GlobalConversation: (asked) => reasonText(asked),
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
    OutsideQuestion: (item) => <OutsideQuestionDetail key={item.id} item={item} now={props.now} />,
    PullRequest: (item) => (
      <PullRequestDetail item={item} now={props.now} onReadReview={props.onReadReview} />
    ),
    GlobalConversation: (item) => <GlobalConversationDetail item={item} now={props.now} />,
  })
}

function DetailHeader(props: {
  item: NeedsYouItem
  title: string
  now: Date
  children: ReactNode
}) {
  return (
    <header className="flex items-start gap-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground">
        <KindIcon item={props.item} className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-baseline gap-3">
          <h2 className="min-w-0 flex-1 text-xl leading-tight font-semibold text-pretty break-words">
            {props.title}
          </h2>
          <Waited since={props.item.since} now={props.now} />
        </div>
        {props.children}
      </div>
    </header>
  )
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
    <article className="flex flex-col gap-6">
      <DetailHeader item={item} title={item.question} now={props.now}>
        <p className="text-sm text-pretty text-muted-foreground">Asked by {item.askedBy}</p>
      </DetailHeader>
      <form
        className="flex flex-col gap-4 rounded-xl border bg-card p-4"
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
              <Label
                key={label}
                className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 font-normal transition-colors duration-150 ease-out hover:bg-muted/50 has-data-checked:border-primary/60 has-data-checked:bg-primary/5"
              >
                <RadioGroupItem value={label} className="mt-px" />
                <span className="min-w-0 text-pretty break-words">{label}</span>
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
        <div className="flex items-center justify-end gap-3">
          <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Kbd>Enter</Kbd>
            sends
          </p>
          <Button type="submit" disabled={sent.waiting || (typed === "" && choice === null)}>
            Send
          </Button>
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
  const { agent } = props.item
  const conversation = useMemo(() => agentConversation(agent.id), [agent.id])

  return (
    <article className="flex flex-col gap-6">
      <DetailHeader item={props.item} title={agent.name} now={props.now}>
        <p className="text-sm text-pretty text-muted-foreground">
          {agent.repository.owner}/{agent.repository.repo} · {reasonText(props.item)}
        </p>
        <Link
          to="/agents/$agentId"
          params={{ agentId: agent.id }}
          className={cn(actionLink, "mt-2 w-fit bg-primary text-primary-foreground")}
        >
          Open the Agent
        </Link>
      </DetailHeader>
      <ConversationContext value={conversation}>
        {requestsOf(props.item).map((part) => (
          <RequestCard key={part.requestId} part={part} />
        ))}
      </ConversationContext>
    </article>
  )
}

function GlobalConversationDetail(props: {
  item: Extract<NeedsYouItem, { _tag: "GlobalConversation" }>
  now: Date
}) {
  const open = useAtomSet(globalConversationOpenAtom)

  return (
    <article className="flex flex-col gap-6">
      <DetailHeader item={props.item} title="Global conversation" now={props.now}>
        <p className="text-sm text-pretty text-muted-foreground">{reasonText(props.item)}</p>
        <Button className="mt-2 w-fit" onClick={() => open(true)}>
          Open the Global conversation
        </Button>
      </DetailHeader>
      <ConversationContext value={globalConversation}>
        {props.item.requests.map((part) => (
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
  const { pullRequest } = props.item
  const markDone = useAtomSet(markDoneAtom)
  const review = finishedAgentReviewOf(props.item)
  const updated = DateTime.toDateUtc(pullRequest.updatedAt)

  return (
    <article className="flex flex-col gap-6">
      <DetailHeader item={props.item} title={pullRequest.title} now={props.now}>
        <p className="text-sm text-pretty text-muted-foreground">
          {referenceText(pullRequest.ref)} · {pullRequest.author}
          {pullRequest.isDraft ? " · Draft" : ""} · Updated {ago(updated, props.now)}
        </p>
        <p className="text-sm text-pretty">{reasonText(props.item)}</p>
      </DetailHeader>
      <div className="flex flex-wrap gap-2 pl-12">
        <Link
          to="/reviews/$owner/$repo/$number"
          params={pullRequest.ref}
          className={cn(actionLink, "bg-primary text-primary-foreground")}
        >
          Open pull request
        </Link>
        {review === undefined ? null : (
          <>
            <Link
              to="/reviews/$owner/$repo/$number"
              params={pullRequest.ref}
              className={cn(actionLink, "border")}
              onClick={() => props.onReadReview(referenceKey(pullRequest.ref))}
            >
              Read Agent review
            </Link>
            <button
              type="button"
              className={cn(actionLink, "border")}
              onClick={() =>
                markDone({ pullRequest: pullRequest.ref, writtenAt: review.writtenAt })
              }
            >
              Done
            </button>
          </>
        )}
      </div>
    </article>
  )
}

import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  type NeedsYouGroup,
  type NeedsYouItem,
  needsYouGroupOf,
  needsYouGroups,
} from "@glass/contracts"
import { cn } from "cn"
import { Option, Predicate } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { ChevronDown, Inbox as InboxIcon } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { AgentRequest, answerRequestAtom } from "./agentsArea"
import { InboxDetail } from "./InboxDetail"
import {
  contextOf,
  firstPermission,
  groupLooks,
  type InboxAction,
  ItemIcon,
  Reasons,
  titleOf,
  Waited,
} from "./inboxItem"
import {
  markDoneAtom,
  needsYouCount,
  needsYouKey,
  type NeedsYouResult,
  needsYouStreamAtom,
  reviewDoneOf,
  watchedNeedsYouAtom,
} from "./needsYou"
import { ProblemAlert } from "./ProblemAlert"
import { streamProblem } from "./problems"
import { readAgentReviewOnOpenAtom } from "./reviewsArea"
import { useShortcuts } from "./useShortcuts"

const pickedAtom = Atom.make<string | null>(null).pipe(Atom.keepAlive)

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

const minute = 60_000

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), minute)

    return () => window.clearInterval(timer)
  }, [])

  return now
}

function InboxCount(props: { status: NeedsYouResult }) {
  const count = needsYouCount(props.status)

  if (Option.isNone(count)) return null

  return <span className="font-normal text-muted-foreground">{count.value}</span>
}

interface GroupRows {
  readonly group: NeedsYouGroup
  readonly rows: ReadonlyArray<NeedsYouItem>
}

function InboxRows(props: { status: NeedsYouResult; onRetry: () => void; children: ReactNode }) {
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
        props.children
      ),
  })
}

function InboxGroups(props: {
  groups: ReadonlyArray<GroupRows>
  selectedKey: string | null
  folded: ReadonlySet<NeedsYouGroup>
  now: Date
  onPick: (key: string) => void
  onFold: (group: NeedsYouGroup) => void
}) {
  return props.groups.map(({ group, rows }) => {
    const open = !props.folded.has(group)

    return (
      <section key={group} aria-label={groupLooks[group].label} className="pb-1">
        <h2>
          <button
            type="button"
            aria-expanded={open}
            className={cn(
              "flex w-full items-center gap-2 px-4 pt-3 pb-1.5 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
              groupLooks[group].tone,
            )}
            onClick={() => props.onFold(group)}
          >
            {groupLooks[group].label}
            <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>
            <ChevronDown
              className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")}
              aria-hidden
            />
          </button>
        </h2>
        {open && (
          <ul className="px-2">
            {rows.map((item) => (
              <li key={needsYouKey(item)}>
                <InboxRow
                  item={item}
                  selected={needsYouKey(item) === props.selectedKey}
                  now={props.now}
                  onPick={props.onPick}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    )
  })
}

function InboxRow(props: {
  item: NeedsYouItem
  selected: boolean
  now: Date
  onPick: (key: string) => void
}) {
  const { item } = props
  const key = needsYouKey(item)

  return (
    <button
      type="button"
      data-inbox-row={key}
      aria-current={props.selected ? "true" : undefined}
      className="grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring aria-[current=true]:bg-accent aria-[current=true]:focus-visible:ring-0"
      onClick={() => props.onPick(key)}
    >
      <ItemIcon item={item} className="row-span-2 mt-0.5 size-4 text-muted-foreground" />
      <span className="truncate font-medium" title={titleOf(item)}>
        {titleOf(item)}
      </span>
      <Waited since={item.since} now={props.now} />
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <Reasons item={item} />
        <span className="truncate text-xs text-muted-foreground" title={contextOf(item)}>
          {contextOf(item)}
        </span>
      </span>
    </button>
  )
}

function InboxPane(props: {
  status: NeedsYouResult
  selected: NeedsYouItem | null
  actions: ReadonlyArray<InboxAction>
  now: Date
  onReadReview: (pullRequest: string) => void
}) {
  return AsyncResult.match(props.status, {
    onInitial: () => null,
    onFailure: () => null,
    onSuccess: ({ value: items }) =>
      props.selected === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
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
        <InboxDetail
          key={needsYouKey(props.selected)}
          item={props.selected}
          now={props.now}
          actions={props.actions}
          onReadReview={props.onReadReview}
        />
      ),
  })
}

/** What the user can do to the selected item; its keys and the detail pane's hints both come from here. */
function useInboxActions(selected: NeedsYouItem | null): ReadonlyArray<InboxAction> {
  const markDone = useAtomSet(markDoneAtom)
  const permission = selected === null ? null : firstPermission(selected)

  const allow = useAtomSet(
    answerRequestAtom(
      new AgentRequest({
        agentId: permission?.agentId ?? "",
        requestId: permission?.requestId ?? "",
      }),
    ),
  )

  if (selected === null) return []

  const done = Predicate.isTagged(selected, "PullRequest") ? reviewDoneOf(selected) : null

  return [
    ...(done === null ? [] : [{ key: "E" as const, label: "done", run: () => markDone(done) }]),
    ...(permission === null
      ? []
      : [{ key: "A" as const, label: "allow", run: () => allow(AllowRequest.make({})) }]),
  ]
}

export function Inbox() {
  const status = useAtomValue(watchedNeedsYouAtom)
  const now = useMinuteClock()
  const retry = useAtomRefresh(needsYouStreamAtom)

  const markReview = useAtomSet(readAgentReviewOnOpenAtom)
  const list = useRef<HTMLDivElement>(null)
  const [folded, setFolded] = useState<ReadonlySet<NeedsYouGroup>>(new Set())

  const items = AsyncResult.isSuccess(status) ? status.value : []

  const groups = needsYouGroups.flatMap((group): ReadonlyArray<GroupRows> => {
    const rows = items.filter((item) => needsYouGroupOf(item) === group)

    return rows.length === 0 ? [] : [{ group, rows }]
  })

  const flat = groups.flatMap(({ group, rows }) => (folded.has(group) ? [] : rows))

  const keys = flat.map(needsYouKey)
  const order = keys.join("\n")
  const [picked, setPicked] = useAtom(pickedAtom)

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
  const actions = useInboxActions(selected)

  // Scrolls only as far as the row needs, so each step moves the list by at most a row.
  const move = (by: 1 | -1) => {
    const at = selectedKey === null ? -1 : keys.indexOf(selectedKey)
    const key = keys[at === -1 ? 0 : Math.min(keys.length - 1, Math.max(0, at + by))]

    if (key === undefined) return

    setPicked(key)
    const row = list.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(key)}"]`)
    row?.focus({ preventScroll: true })
    row?.scrollIntoView({ block: "nearest" })
  }

  const fold = (group: NeedsYouGroup) =>
    setFolded((last) => {
      const next = new Set(last)

      if (!next.delete(group)) next.add(group)

      return next
    })

  useShortcuts([
    { key: "j", allowRepeat: true, run: () => move(1) },
    { key: "k", allowRepeat: true, run: () => move(-1) },
    ...actions.map(({ key, run }) => ({ key, run })),
  ])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-96 shrink-0 flex-col border-r">
        <header className="border-b px-4 py-3">
          <h1 className="text-base font-semibold">
            Inbox <InboxCount status={status} />
          </h1>
        </header>
        <div ref={list} className="min-h-0 flex-1 overflow-y-auto">
          <InboxRows status={status} onRetry={retry}>
            <InboxGroups
              groups={groups}
              selectedKey={selectedKey}
              folded={folded}
              now={now}
              onPick={setPicked}
              onFold={fold}
            />
          </InboxRows>
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <InboxPane
          status={status}
          selected={selected}
          actions={actions}
          now={now}
          onReadReview={markReview}
        />
      </div>
    </div>
  )
}

import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  AllowRequest,
  type InboxGroup,
  type InboxItem,
  inboxGroupOf,
  inboxGroups,
} from "@glass/contracts"
import { cn } from "cn"
import { Match } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import { Listbox, ListboxItem, ListboxItemIcon } from "@ui-sdk/react/listbox"
import { ChevronDown, Inbox as InboxIcon } from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import { ThreadRequest, answerRequestAtom } from "./threadsArea"
import { InboxHeadingCount } from "./InboxCount"
import { InboxDetail } from "./InboxDetail"
import {
  contextOf,
  firstPermission,
  groupLooks,
  type InboxAction,
  inboxItemKey,
  inboxKeys,
  ItemIcon,
  Reasons,
  reviewDoneOf,
  titleOf,
  turnSeenOf,
  Waited,
} from "./inboxItem"
import {
  markDoneAtom,
  markTurnSeenAtom,
  type InboxResult,
  inboxStreamAtom,
  watchedInboxAtom,
} from "./inboxArea"
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

export function useMinuteClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), minute)

    return () => window.clearInterval(timer)
  }, [])

  return now
}

interface GroupRows {
  readonly group: InboxGroup
  readonly rows: ReadonlyArray<InboxItem>
}

function InboxRows(props: { status: InboxResult; onRetry: () => void; children: ReactNode }) {
  return AsyncResult.match(props.status, {
    onInitial: () => (
      <output className="block px-4 py-3 text-sm text-muted-foreground">Loading…</output>
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
  folded: ReadonlySet<InboxGroup>
  now: Date
  onPick: (key: string) => void
  onFold: (group: InboxGroup) => void
}) {
  return props.groups.map(({ group, rows }) => {
    const open = !props.folded.has(group)
    const { label } = groupLooks[group]

    return (
      <section key={group} aria-label={label} className="pb-1">
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
            {label}
            <span className="font-normal text-muted-foreground tabular-nums">{rows.length}</span>
            <ChevronDown
              className={cn("ml-auto size-3.5 transition-transform", !open && "-rotate-90")}
              aria-hidden
            />
          </button>
        </h2>
        {open && (
          <Listbox
            aria-label={label}
            loop={false}
            value={props.selectedKey}
            onValueChange={(key) => key !== null && props.onPick(key)}
            className="px-2 outline-none"
          >
            {rows.map((item) => (
              <InboxRow key={inboxItemKey(item)} item={item} now={props.now} />
            ))}
          </Listbox>
        )}
      </section>
    )
  })
}

function InboxRow(props: { item: InboxItem; now: Date }) {
  const { item } = props
  const title = titleOf(item)

  return (
    <ListboxItem
      value={inboxItemKey(item)}
      className="grid cursor-default grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-md px-2 py-2 text-sm outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring data-[selected]:bg-accent data-[selected]:focus-visible:ring-0"
    >
      <ListboxItemIcon className="row-span-2 mt-0.5">
        <ItemIcon item={item} className="size-4 text-muted-foreground" />
      </ListboxItemIcon>
      <span className="truncate font-medium" title={title}>
        {title}
      </span>
      <Waited since={item.since} now={props.now} />
      <span className="col-span-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <Reasons item={item} />
        <span className="truncate text-xs text-muted-foreground" title={contextOf(item)}>
          {contextOf(item)}
        </span>
      </span>
    </ListboxItem>
  )
}

function InboxPane(props: {
  status: InboxResult
  selected: InboxItem | null
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
          key={inboxItemKey(props.selected)}
          item={props.selected}
          now={props.now}
          actions={props.actions}
          onReadReview={props.onReadReview}
        />
      ),
  })
}

function useInboxActions(selected: InboxItem | null): ReadonlyArray<InboxAction> {
  const markDone = useAtomSet(markDoneAtom)
  const markTurnSeen = useAtomSet(markTurnSeenAtom)
  const permission = selected === null ? null : firstPermission(selected)

  const allow = useAtomSet(
    answerRequestAtom(
      new ThreadRequest({
        threadId: permission?.threadId ?? "",
        requestId: permission?.requestId ?? "",
      }),
    ),
  )

  if (selected === null) return []

  const done = Match.valueTags(selected, {
    PullRequest: (item) => {
      const review = reviewDoneOf(item)

      return review === null ? null : () => markDone(review)
    },
    Thread: (item) => {
      const seen = turnSeenOf(item)

      return seen === null ? null : () => markTurnSeen(seen)
    },
    OutsideQuestion: () => null,
    CheckIn: () => null,
    GlobalChat: () => null,
  })

  return [
    ...(done === null ? [] : [{ key: "E" as const, label: "done", run: done }]),
    ...(permission === null
      ? []
      : [{ key: "A" as const, label: "allow", run: () => allow(AllowRequest.make({})) }]),
  ]
}

export function Inbox() {
  const status = useAtomValue(watchedInboxAtom)
  const now = useMinuteClock()
  const retry = useAtomRefresh(inboxStreamAtom)

  const markReview = useAtomSet(readAgentReviewOnOpenAtom)
  const [folded, setFolded] = useState<ReadonlySet<InboxGroup>>(new Set())

  const items = AsyncResult.isSuccess(status) ? status.value : []

  const groups = inboxGroups.flatMap((group): ReadonlyArray<GroupRows> => {
    const rows = items.filter((item) => inboxGroupOf(item) === group)

    return rows.length === 0 ? [] : [{ group, rows }]
  })

  const flat = groups.flatMap(({ group, rows }) => (folded.has(group) ? [] : rows))

  const keys = flat.map(inboxItemKey)
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
  const selected = flat.find((item) => inboxItemKey(item) === selectedKey) ?? null
  const actions = useInboxActions(selected)

  const fold = (group: InboxGroup) =>
    setFolded((last) => {
      const next = new Set(last)

      if (!next.delete(group)) next.add(group)

      return next
    })

  useShortcuts(
    inboxKeys.map((key) => ({
      key,
      beforeWidgets: true,
      run: () => actions.find((action) => action.key === key)?.run(),
    })),
  )

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-96 shrink-0 flex-col border-r">
        <header className="border-b px-4 py-3">
          <h1 className="text-base font-semibold">
            Inbox <InboxHeadingCount />
          </h1>
        </header>
        <div className="relative min-h-0 flex-1 overflow-y-auto">
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

import { RegistryContext, useAtom, useAtomSet, useAtomValue } from "@effect/atom-react"
import {
  findPullRequestReferences,
  parsePullRequestReference,
  type PullRequestRef,
  referenceKey,
  repositoryKey,
  referenceText,
} from "@glass/contracts"
import {
  Command,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandItemIcon,
  CommandItemText,
  CommandList,
  CommandShortcut,
} from "@ui-sdk/react/command"
import { Option } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
import {
  GitPullRequest,
  GitPullRequestArrow,
  ListPlus,
  Search,
  Sparkles,
  SquarePen,
} from "lucide-react"
import { type RefObject, useContext, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"
import { type Action, actionGroups, mountedActions, shortcutKeys } from "./actions"
import { threadsAtom } from "./threadsArea"
import { knownPullRequestsAtom } from "./pullRequestLists"
import { addToQueue } from "./queue"
import { refusedEscape } from "./refusedEscape"
import { sameRef } from "./reviewsArea"
import { shortcutLabel } from "./shortcutLabel"
import { useShortcuts } from "./useShortcuts"

const commandMenuOpenAtom = Atom.make(false)

const recentAtom = Atom.make<ReadonlyArray<string>>([]).pipe(Atom.keepAlive)

const RECENT_LIMIT = 5

type Row = Omit<Action, "group">

interface Section {
  readonly label: string
  readonly entries: ReadonlyArray<{ readonly value: string; readonly row: Row }>
}

export function OpenPullRequestButton() {
  const setOpen = useAtomSet(commandMenuOpenAtom)

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label="Open another PR"
      aria-keyshortcuts="Meta+L Control+L"
      title={`Open another PR (${shortcutLabel("L")})`}
      onClick={() => setOpen(true)}
    >
      <GitPullRequestArrow aria-hidden />
    </Button>
  )
}

interface Destinations {
  readonly current: PullRequestRef | undefined
  readonly onOpen: (pullRequest: PullRequestRef) => void
  readonly onOpenThread: (threadId: string) => void
  readonly onStartThread: (message: string) => void
  readonly onViewQueue: () => void
}

interface PastedRows {
  readonly open: Row | null
  readonly queue: Row | null
}

export const pastedRows = (
  query: string,
  current: PullRequestRef | undefined,
  open: (pullRequest: PullRequestRef) => void,
  queue: (pullRequests: ReadonlyArray<PullRequestRef>) => void,
): PastedRows => {
  const references = findPullRequestReferences(query)
  const queueShortcut = { key: "Enter", mod: true }

  if (references.length > 1)
    return {
      open: null,
      queue: {
        id: "queue-pasted",
        title: `Queue ${references.length} PRs: ${references.map(referenceText).join(", ")}`,
        icon: ListPlus,
        shortcut: queueShortcut,
        run: () => queue(references),
      },
    }

  const reference = parsePullRequestReference(query)

  if (reference === null) return { open: null, queue: null }

  return {
    open:
      current !== undefined && sameRef(reference, current)
        ? null
        : {
            id: "open-pasted",
            title: `Open ${referenceText(reference)}`,
            icon: GitPullRequestArrow,
            run: () => open(reference),
          },
    queue: {
      id: "queue-pasted",
      title: `Add ${referenceText(reference)} to the Queue`,
      icon: ListPlus,
      shortcut: queueShortcut,
      run: () => queue([reference]),
    },
  }
}

export function CommandMenu(props: Destinations) {
  const [open, setOpen] = useAtom(commandMenuOpenAtom)
  const input = useRef<HTMLInputElement>(null)
  const chosen = useRef<Row | null>(null)

  useShortcuts([
    {
      key: "k",
      mod: true,
      allowInEditable: true,
      allowInDialog: true,
      run: () => setOpen(!open),
    },
    {
      key: "l",
      mod: true,
      allowInEditable: true,
      allowInDialog: true,
      run: () => (open ? input.current?.select() : setOpen(true)),
    },
  ])

  const run = (row: Row) => {
    chosen.current = row
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next, details) => {
        if (refusedEscape(details)) return

        setOpen(next)
      }}
      onOpenChangeComplete={(isOpen) => {
        const row = chosen.current
        chosen.current = null

        if (!isOpen) row?.run()
      }}
    >
      <DialogContent
        instant
        showCloseButton={false}
        initialFocus={input}
        className="top-[14vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <MenuBody {...props} inputRef={input} onRun={run} />
        <footer className="flex justify-end gap-3.5 border-t px-3.5 py-2 text-xs text-muted-foreground">
          <span>
            <Kbd>↑↓</Kbd> Move
          </span>
          <span>
            <Kbd>↵</Kbd> Run
          </span>
          <span>
            <Kbd>esc</Kbd> Close
          </span>
        </footer>
      </DialogContent>
    </Dialog>
  )
}

function MenuBody({
  inputRef,
  onRun,
  ...props
}: Destinations & {
  inputRef: RefObject<HTMLInputElement | null>
  onRun: (row: Row) => void
}) {
  const registry = useContext(RegistryContext)
  const [query, setQuery] = useState("")
  const [recent, setRecent] = useAtom(recentAtom)
  const jumps = useJumps(props)

  const pasted = pastedRows(
    query,
    props.current,
    props.onOpen,
    (references) => void addToQueue(registry, references, props.onViewQueue),
  )

  const pastedList = [pasted.open, pasted.queue].filter((row) => row !== null)
  const trimmed = query.trim()
  const searching = trimmed !== ""
  const mounted = mountedActions()

  const byId = new Map(
    [...mounted, ...jumps.pullRequests, ...jumps.threads].map((row) => [row.id, row]),
  )

  const recentRows = searching
    ? []
    : recent.flatMap((id) => {
        const row = byId.get(id)

        return row === undefined ? [] : [row]
      })

  const startRow: Row = {
    id: `start-thread:${trimmed}`,
    title: trimmed,
    icon: SquarePen,
    run: () => props.onStartThread(trimmed),
  }

  const sections = (
    pastedList.length > 0
      ? [section("Pasted PR", pastedList)]
      : [
          section("Recent", recentRows, "recent:"),
          ...actionGroups.map((group) =>
            section(
              group,
              mounted.filter((action) => action.group === group),
            ),
          ),
          section("PRs", searching ? jumps.pullRequests : []),
          section("Threads", searching ? jumps.threads : []),
          section("Start a Thread", searching ? [startRow] : []),
        ]
  ).filter(({ entries }) => entries.length > 0)

  const run = (value: string) => {
    const entry = sections.flatMap(({ entries }) => entries).find((each) => each.value === value)

    if (entry === undefined) return

    if (byId.has(entry.row.id))
      setRecent((ids) =>
        [entry.row.id, ...ids.filter((id) => id !== entry.row.id)].slice(0, RECENT_LIMIT),
      )

    onRun(entry.row)
  }

  return (
    <Command
      query={query}
      onQueryChange={setQuery}
      onAction={run}
      filter={pastedList.length > 0 ? false : "fuzzy"}
      autoHighlight
      loop
      className="min-w-0"
    >
      <div className="flex items-center gap-2.5 border-b px-3.5">
        <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <CommandInput
          ref={inputRef}
          aria-label="Search actions, or paste a PR"
          placeholder="Search actions, PRs, and Threads, or paste a PR URL"
          spellCheck={false}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey) || !pasted.queue) return

            event.preventDefault()
            onRun(pasted.queue)
          }}
          className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
        />
      </div>
      <CommandList className="max-h-[min(24rem,60vh)] overflow-y-auto overscroll-contain p-1.5">
        {sections.map((each) => (
          <MenuSection key={each.label} section={each} />
        ))}
      </CommandList>
    </Command>
  )
}

const section = (label: string, rows: ReadonlyArray<Row>, prefix = ""): Section => ({
  label,
  entries: rows.map((row) => ({ value: prefix + row.id, row })),
})

function useJumps({ onOpen, onOpenThread }: Destinations) {
  const pullRequests = useAtomValue(knownPullRequestsAtom)

  const threads = Option.getOrElse(AsyncResult.value(useAtomValue(threadsAtom)), () => [])

  return {
    pullRequests: pullRequests.map(({ ref, title }): Row => ({
      id: `pr:${referenceKey(ref)}`,
      title,
      detail: referenceText(ref),
      icon: GitPullRequest,
      keywords: [referenceText(ref)],
      run: () => onOpen(ref),
    })),
    threads: threads
      .filter(({ forReview }) => !forReview)
      .map(({ id, name, repository }): Row => ({
        id: `thread:${id}`,
        title: name,
        detail: repositoryKey(repository),
        icon: Sparkles,
        keywords: [repositoryKey(repository)],
        run: () => onOpenThread(id),
      })),
  }
}

function MenuSection(props: { section: Section }) {
  const { label, entries } = props.section

  return (
    <CommandGroup className="not-first:mt-1.5">
      <CommandGroupLabel className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium text-muted-foreground">
        {label}
      </CommandGroupLabel>
      {entries.map(({ value, row }) => (
        <CommandItem
          key={value}
          value={value}
          label={row.title}
          keywords={[...(row.keywords ?? [])]}
          className="flex cursor-default items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
        >
          {row.icon && (
            <CommandItemIcon>
              <row.icon className="size-4 text-muted-foreground" aria-hidden />
            </CommandItemIcon>
          )}
          <CommandItemText className="min-w-0 truncate [&_mark]:bg-transparent [&_mark]:font-semibold [&_mark]:text-foreground" />
          {row.detail && (
            <span className="shrink-0 text-xs text-muted-foreground">{row.detail}</span>
          )}
          {row.shortcut && (
            <CommandShortcut
              shortcut={shortcutKeys(row.shortcut)}
              className="ml-auto shrink-0 text-xs text-muted-foreground"
            />
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  )
}

import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import type { QueuedPullRequest } from "@glass/contracts"
import { Link, type LinkProps } from "@tanstack/react-router"
import { AsyncResult } from "effect/reactivity"
import { ArrowRight, Circle } from "lucide-react"
import { type ReactNode, useId } from "react"
import { AgentContinueCard } from "./AgentContinueCard"
import type { BackendError } from "./backend"
import { Count } from "./Lists"
import { ProblemAlert } from "./ProblemAlert"
import { problemOf } from "./problems"
import { repositoryLabeller } from "./PullRequestRow"
import { savedQueueAtom, watchedQueueAtom } from "./queue"
import { QueueTourStatus } from "./QueueTourStatus"
import { ReviewContinueCard } from "./ReviewContinueCard"
import { defaultListSearch } from "./reviewsArea"
import { loadedPlacesAtom, savedDestinationsAtom, savedIn } from "./savedPlace"
import { openToDosAtom, savedToDosAtom } from "./toDoList"

const panelLimit = 5

export function Dashboard() {
  return (
    <div className="page-content @container flex flex-col gap-8 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
      <Continue />
      <div className="grid gap-8 @3xl:grid-cols-2">
        <QueuePanel />
        <ToDosPanel />
      </div>
    </div>
  )
}

function Continue() {
  const result = useAtomValue(savedDestinationsAtom)
  const retry = useAtomRefresh(loadedPlacesAtom)

  return (
    <section aria-labelledby="continue-heading" className="flex flex-col gap-4">
      <h2 id="continue-heading" className="text-base font-semibold">
        Continue where you left off
      </h2>
      {AsyncResult.builder(result)
        .onSuccess((destinations) => (
          <div className="grid gap-4 @3xl:grid-cols-2">
            <ReviewContinueCard destination={savedIn(destinations, "reviews")} />
            <AgentContinueCard destination={savedIn(destinations, "agents")} />
          </div>
        ))
        .onFailure((cause) => (
          <ProblemAlert problem={problemOf(cause)} action={{ label: "Retry", run: retry }} />
        ))
        .orElse(() => (
          <output className="py-6 text-sm text-muted-foreground">Loading your saved place…</output>
        ))}
    </section>
  )
}

function Panel<A>(props: {
  title: string
  link: LinkProps
  linkLabel: string
  result: AsyncResult.AsyncResult<ReadonlyArray<A>, BackendError>
  retry: () => void
  loading: string
  empty: string
  children: (items: ReadonlyArray<A>) => ReactNode
}) {
  const id = useId()

  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 id={id} className="text-base font-semibold">
          {props.title}
        </h2>
        <Count count={AsyncResult.isSuccess(props.result) ? props.result.value.length : 0} />
        <Link
          {...props.link}
          className="ml-auto flex items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {props.linkLabel} <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
      <div className="border-t pt-1">
        {AsyncResult.builder(props.result)
          .onSuccess((items) =>
            items.length === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">{props.empty}</p>
            ) : (
              props.children(items.slice(0, panelLimit))
            ),
          )
          .onFailure((cause) => (
            <ProblemAlert
              problem={problemOf(cause)}
              action={{ label: "Retry", run: props.retry }}
            />
          ))
          .orElse(() => (
            <output className="block py-2 text-sm text-muted-foreground">{props.loading}</output>
          ))}
      </div>
    </section>
  )
}

function QueuePanel() {
  return (
    <Panel
      title="Queue"
      link={{ to: "/reviews", search: { ...defaultListSearch, list: "queue" } }}
      linkLabel="Go to the Queue"
      result={useAtomValue(watchedQueueAtom)}
      retry={useAtomRefresh(savedQueueAtom)}
      loading="Loading the Queue…"
      empty="Your Queue is empty."
    >
      {(entries) => <QueueItems entries={entries} />}
    </Panel>
  )
}

function QueueItems(props: { entries: ReadonlyArray<QueuedPullRequest> }) {
  const repositoryLabel = repositoryLabeller(
    props.entries.map(({ pullRequest }) => pullRequest.ref),
  )

  return (
    <ol aria-label="Queue">
      {props.entries.map((queued) => (
        <li key={queued.pullRequest.url}>
          <Link
            to="/reviews/$owner/$repo/$number"
            params={queued.pullRequest.ref}
            className="-mx-2 flex h-9 items-center gap-2.5 rounded-md px-2 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="min-w-0 flex-1 truncate">
              <span className="font-medium">{queued.pullRequest.title}</span>{" "}
              <span className="text-xs text-muted-foreground">
                {repositoryLabel(queued.pullRequest.ref)}
              </span>
            </span>
            <QueueTourStatus queued={queued} />
          </Link>
        </li>
      ))}
    </ol>
  )
}

function ToDosPanel() {
  return (
    <Panel
      title="To-dos"
      link={{ to: "/to-dos" }}
      linkLabel="Go to To-dos"
      result={useAtomValue(openToDosAtom)}
      retry={useAtomRefresh(savedToDosAtom)}
      loading="Loading to-dos…"
      empty="Nothing to do."
    >
      {(toDos) => (
        <ul aria-label="Open to-dos">
          {toDos.map((toDo) => (
            <li key={toDo.id} className="flex h-9 items-center gap-2.5 text-sm">
              <Circle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{toDo.title}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

import {
  type FollowedRepository,
  type PullRequestList,
  type PullRequestRef,
  type PullRequestSummary,
  parsePullRequestReference,
  repositoryKey,
} from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { useAtom, useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { DateTime } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ArrowRight, RefreshCw, RotateCw, TriangleAlert } from "lucide-react"
import { type FormEvent, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Empty } from "./Lists"
import { OpenPullRequestDialog } from "./OpenPullRequestDialog"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import { type Problem, problemText, streamProblem } from "./problems"
import {
  columns,
  columnsWithRepository,
  NotRefreshed,
  PullRequestRow,
  repositoryLabeller,
  subgridRow,
  warningTone,
} from "./PullRequestRow"
import { type Group, Health, Latest, listingsAtom, syncListingsAtom } from "./pullRequestLists"
import { queueRefreshAtom } from "./queue"
import { QueueTab, QueueTabTrigger } from "./QueueTab"
import { recency, recencyOf } from "./recency"
import type { ListSearch, ListView } from "./reviewsArea"

const tabs: ReadonlyArray<{
  readonly list: PullRequestList
  readonly label: string
  readonly emptyTitle: string
  readonly emptyBody: (repositories: string) => string
}> = [
  {
    list: "needs-review",
    label: "Needs review",
    emptyTitle: "No PRs need your review",
    emptyBody: (repositories) =>
      `Review requests to you or your teams in ${repositories} appear here.`,
  },
  {
    list: "my-prs",
    label: "My PRs",
    emptyTitle: "You have no open PRs",
    emptyBody: (repositories) => `Your open PRs in ${repositories}, including drafts, appear here.`,
  },
  {
    list: "reviewing",
    label: "Reviewing",
    emptyTitle: "No PRs to resume",
    emptyBody: (repositories) =>
      `Open a PR in ${repositories} to find it here later. PRs with your Drafts or submitted Reviews also appear here.`,
  },
]

export function PullRequestListPage(props: {
  search: ListSearch
  onSearch: (search: ListSearch) => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const [synced, sync] = useAtom(syncListingsAtom)

  const queue = useAtomValue(queueRefreshAtom)

  const refreshQueue = useAtomRefresh(queueRefreshAtom)

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="page-content flex flex-col py-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
          {props.search.list !== "queue" && <NotRefreshedNote list={props.search.list} />}
          <span className="ml-auto flex items-center gap-2">
            <PullRequestUrlForm onOpen={props.onOpen} />
            <OpenPullRequestDialog onOpen={props.onOpen} />
            <ToggleGroup
              variant="outline"
              size="sm"
              spacing={0}
              value={[props.search.view]}
              onValueChange={([view]) => {
                const chosen = views.find(({ value }) => value === view)

                if (chosen !== undefined) props.onSearch({ ...props.search, view: chosen.value })
              }}
              aria-label="Arrange PRs"
            >
              {views.map(({ value, label }) => (
                <ToggleGroupItem key={value} value={value}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <RefreshButton
              results={[synced, queue]}
              onRefresh={() => {
                sync()
                refreshQueue()
              }}
            />
          </span>
        </div>
        <Tabs
          value={props.search.list}
          onValueChange={(next: ListSearch["list"]) =>
            props.onSearch({ ...props.search, list: next })
          }
          className="mt-5 gap-0"
        >
          <div className="border-b">
            <TabsList variant="line" aria-label="PR lists">
              {tabs.map(({ list, label }) => (
                <TabsTrigger key={list} value={list} className="flex-none px-2">
                  {label}
                </TabsTrigger>
              ))}
              <QueueTabTrigger />
            </TabsList>
          </div>
          {tabs.map((tab) => (
            <TabsContent key={tab.list} value={tab.list} className="flex flex-col pt-2">
              <ListResults tab={tab} view={props.search.view} onOpen={props.onOpen} />
            </TabsContent>
          ))}
          <TabsContent value="queue">
            <QueueTab onOpen={props.onOpen} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  )
}

function RefreshButton(props: {
  results: ReadonlyArray<AsyncResult.AsyncResult<unknown, unknown>>
  onRefresh: () => void
}) {
  const [requestedAt, setRequestedAt] = useState<number | null>(null)

  const answered = props.results.every(
    (result) =>
      !result.waiting &&
      (!AsyncResult.isSuccess(result) || result.timestamp >= (requestedAt ?? -Infinity)),
  )

  if (requestedAt !== null && answered) setRequestedAt(null)

  const spinning = requestedAt !== null && !answered

  const refreshNow = () => {
    setRequestedAt(Date.now())
    props.onRefresh()
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Refresh"
      aria-busy={spinning}
      onClick={refreshNow}
    >
      <RefreshCw className={cn(spinning && "animate-spin")} aria-hidden />
    </Button>
  )
}

function NotRefreshedNote(props: { list: PullRequestList }) {
  const result = useAtomValue(listingsAtom)

  if (!AsyncResult.isSuccess(result) || !Latest.$is("Listed")(result.value)) return null

  const { notRefreshed } = result.value.listings[props.list]

  if (notRefreshed === undefined) return null

  return (
    <output aria-label="List status" className="text-xs whitespace-nowrap text-muted-foreground">
      <NotRefreshed problem={notRefreshed} showLabel />
    </output>
  )
}

function ListResults(props: {
  tab: (typeof tabs)[number]
  view: ListView
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const result = useAtomValue(listingsAtom)

  const resubscribe = useAtomRefresh(listingsAtom)

  const sync = useAtomSet(syncListingsAtom)

  if (AsyncResult.isFailure(result)) {
    return (
      <div className="py-4">
        <ProblemAlert
          problem={streamProblem(result.cause)}
          action={{ label: "Retry", run: resubscribe }}
        />
      </div>
    )
  }

  if (AsyncResult.isSuccess(result) && Latest.$is("Failed")(result.value)) {
    return (
      <div className="py-4">
        <ProblemAlert problem={result.value.problem} action={{ label: "Retry", run: sync }} />
      </div>
    )
  }

  if (AsyncResult.isSuccess(result) && Latest.$is("Listed")(result.value)) {
    const { groups, problem, notRefreshed } = result.value.listings[props.tab.list]

    return (
      <LoadedList
        groups={groups}
        problem={problem}
        failed={notRefreshed !== undefined}
        view={props.view}
        emptyTitle={props.tab.emptyTitle}
        emptyBody={props.tab.emptyBody}
        onRefresh={sync}
        onOpen={props.onOpen}
      />
    )
  }

  return <output className="py-6 text-sm text-muted-foreground">Loading PRs…</output>
}

const updatedMillis = (pullRequest: PullRequestSummary) =>
  DateTime.toEpochMillis(pullRequest.updatedAt)

function LoadedList(props: {
  groups: ReadonlyArray<Group>
  problem: Problem | undefined
  failed: boolean
  emptyTitle: string
  emptyBody: (repositories: string) => string
  view: ListView
  onRefresh: () => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  if (props.groups.length === 0 && props.problem === undefined && !props.failed) {
    return (
      <Empty title="No followed repositories">
        <p>Choose the repositories you want to review in Glass.</p>
        <Link className="font-medium text-foreground underline underline-offset-4" to="/settings">
          Follow repositories
        </Link>
      </Empty>
    )
  }

  const shown = props.groups.filter(
    (group) => group.pullRequests.length > 0 || Health.$is("Unavailable")(group.health),
  )

  const recent = props.view === "recent"

  return (
    <>
      {props.problem !== undefined && (
        <div className="pb-2.5">
          <ProblemAlert problem={props.problem} action={{ label: "Retry", run: props.onRefresh }} />
        </div>
      )}
      <div className={cn("grid gap-x-2.5", recent ? columnsWithRepository : columns)}>
        {recent ? (
          <>
            {shown.flatMap(({ repository, health }) =>
              Health.$is("Unavailable")(health)
                ? [
                    <UnavailableRow
                      key={repositoryKey(repository)}
                      repository={repository}
                      problem={health.problem}
                      showRepository
                      onRetry={props.onRefresh}
                    />,
                  ]
                : [],
            )}
            <RecencySections
              rows={shown.flatMap(rowsOf)}
              repositoryLabel={repositoryLabeller(props.groups.map(({ repository }) => repository))}
              onOpen={props.onOpen}
            />
          </>
        ) : (
          <RepositorySections groups={shown} onRefresh={props.onRefresh} onOpen={props.onOpen} />
        )}
      </div>
      {shown.length === 0 && props.problem === undefined && !props.failed && (
        <Empty title={props.emptyTitle}>
          <p>
            {props.emptyBody(
              plural(props.groups.length, "followed repository", "followed repositories"),
            )}
          </p>
        </Empty>
      )}
    </>
  )
}

const views: ReadonlyArray<{ readonly value: ListView; readonly label: string }> = [
  { value: "recent", label: "Recent" },
  { value: "repository", label: "By repository" },
]

function UnavailableRow(props: {
  repository: FollowedRepository
  problem: Problem
  showRepository: boolean
  onRetry: () => void
}) {
  return (
    <Item variant="outline" size="xs" className="col-span-full border-dashed">
      <ItemMedia variant="icon">
        <TriangleAlert className={warningTone} aria-hidden />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>
          {props.showRepository
            ? `Couldn't load ${repositoryKey(props.repository)}`
            : "Couldn't load PRs"}
        </ItemTitle>
        <ItemDescription>{problemText(props.problem)}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <Button variant="outline" size="xs" onClick={props.onRetry}>
          <RotateCw data-icon="inline-start" aria-hidden />
          Retry
        </Button>
      </ItemActions>
    </Item>
  )
}

interface Row {
  readonly pullRequest: PullRequestSummary
  readonly notRefreshed: Problem | undefined
}

const rowsOf = (group: Group): ReadonlyArray<Row> => {
  const notRefreshed = Health.$is("NotRefreshed")(group.health) ? group.health.problem : undefined

  return group.pullRequests.map((pullRequest) => ({ pullRequest, notRefreshed }))
}

function RepositorySections(props: {
  groups: ReadonlyArray<Group>
  onRefresh: () => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const now = new Date()

  return props.groups.map((group) => {
    const name = repositoryKey(group.repository)

    return (
      <section key={name} aria-label={name} className={cn(subgridRow, "pb-2.5")}>
        <h2 className="col-span-full flex items-center gap-2 px-2.5 pt-3 pb-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{name}</span>
          {Health.$is("NotRefreshed")(group.health) && (
            <NotRefreshed problem={group.health.problem} showLabel />
          )}
        </h2>
        {Health.$is("Unavailable")(group.health) && (
          <UnavailableRow
            repository={group.repository}
            problem={group.health.problem}
            showRepository={false}
            onRetry={props.onRefresh}
          />
        )}
        <ul className={subgridRow}>
          {rowsOf(group).map((row) => (
            <li key={row.pullRequest.url} className={subgridRow}>
              <PullRequestRow
                pullRequest={row.pullRequest}
                dimmed={row.notRefreshed !== undefined}
                now={now}
                onOpen={props.onOpen}
              />
            </li>
          ))}
        </ul>
      </section>
    )
  })
}

function RecencySections(props: {
  rows: ReadonlyArray<Row>
  repositoryLabel: (ref: PullRequestRef) => string
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const now = new Date()

  const buckets = Map.groupBy(
    props.rows.toSorted((a, b) => updatedMillis(b.pullRequest) - updatedMillis(a.pullRequest)),
    (row) => recencyOf(DateTime.toDateUtc(row.pullRequest.updatedAt), now),
  )

  return recency.map((bucket) => {
    const rows = buckets.get(bucket)

    if (rows === undefined) return null

    return (
      <section key={bucket} aria-label={bucket} className={cn(subgridRow, "pb-2.5")}>
        <h2 className="col-span-full px-2.5 pt-3 pb-1 text-xs font-medium text-muted-foreground">
          {bucket}
        </h2>
        <ul className={subgridRow}>
          {rows.map((row) => (
            <li key={row.pullRequest.url} className={subgridRow}>
              <PullRequestRow
                pullRequest={row.pullRequest}
                dimmed={row.notRefreshed !== undefined}
                notRefreshed={row.notRefreshed}
                now={now}
                repository={props.repositoryLabel(row.pullRequest.ref)}
                onOpen={props.onOpen}
              />
            </li>
          ))}
        </ul>
      </section>
    )
  })
}

function PullRequestUrlForm(props: { onOpen: (pullRequest: PullRequestRef) => void }) {
  const [address, setAddress] = useState("")

  const reference = parsePullRequestReference(address)

  const submit = (event: FormEvent) => {
    event.preventDefault()

    if (reference !== null) props.onOpen(reference)
  }

  return (
    <form onSubmit={submit} className="relative w-72">
      <Input
        aria-label="Open a PR"
        placeholder="Open owner/repo#123 or a URL"
        value={address}
        onChange={(event) => setAddress(event.target.value)}
        spellCheck={false}
        className="h-7 pr-8"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-xs"
        aria-label="Open"
        disabled={reference === null}
        className="absolute top-0.5 right-0.5"
      >
        <ArrowRight aria-hidden />
      </Button>
    </form>
  )
}

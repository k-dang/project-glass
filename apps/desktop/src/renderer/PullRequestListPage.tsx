import {
  type FollowedRepository,
  type PullRequestList,
  type PullRequestListings,
  type PullRequestRef,
  type PullRequestSummary,
  parsePullRequestReference,
  type RepositoryListing,
  repositoryKey,
} from "@glass/contracts"
import { Link } from "@tanstack/react-router"
import { cn } from "cn"
import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import { Data, DateTime, Effect, Match, Option, Record } from "effect"
import { AsyncResult, Atom } from "effect/reactivity"
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
import { Backend, type BackendError, backendRuntime } from "./backend"
import { followedRepositoriesRevisionAtom } from "./FollowedRepositories"
import { Empty } from "./Lists"
import { plural } from "./plural"
import { ProblemAlert } from "./ProblemAlert"
import { describeError, type Problem, problemOf, problemText } from "./problems"
import {
  columns,
  columnsWithRepository,
  NotRefreshed,
  PullRequestRow,
  repositoryLabeller,
  subgridRow,
  warningTone,
} from "./PullRequestRow"
import { queueRefreshAtom } from "./queue"
import { QueueTab, QueueTabTrigger } from "./QueueTab"
import { recency, recencyOf } from "./recency"
import type { ListSearch, ListView } from "./reviewsArea"
import { watched } from "./watched"
import { reviewingRevisionAtom } from "./workspaceEvents"

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

type Health = Data.TaggedEnum<{
  Current: {}
  NotRefreshed: { readonly problem: Problem }
  Unavailable: { readonly problem: Problem }
}>

const Health = Data.taggedEnum<Health>()

interface Group {
  readonly repository: FollowedRepository
  readonly pullRequests: ReadonlyArray<PullRequestSummary>
  readonly health: Health
}

interface Listing {
  readonly groups: ReadonlyArray<Group>
  readonly problem: Problem | undefined
  readonly notRefreshed: Problem | undefined
}

type Listings = Readonly<Record<PullRequestList, Listing>>

const groupOf = (listing: RepositoryListing): Group =>
  Match.valueTags(listing, {
    RepositoryPullRequests: ({ repository, pullRequests }): Group => ({
      repository,
      pullRequests,
      health: Health.Current(),
    }),
    RepositoryUnavailable: ({ repository, error, pullRequests }): Group => ({
      repository,
      pullRequests,
      health:
        pullRequests.length > 0
          ? Health.NotRefreshed({ problem: describeError(error) })
          : Health.Unavailable({ problem: describeError(error) }),
    }),
  })

const markNotRefreshed =
  (problem: Problem) =>
  (group: Group): Group =>
    Health.$is("Current")(group.health) && group.pullRequests.length > 0
      ? { ...group, health: Health.NotRefreshed({ problem }) }
      : group

const listed = (repositories: ReadonlyArray<RepositoryListing>): Listing => ({
  groups: repositories.map(groupOf),
  problem: undefined,
  notRefreshed: undefined,
})

const listingsOf = (listings: PullRequestListings): Listings => ({
  "needs-review": listed(listings["needs-review"]),
  "my-prs": listed(listings["my-prs"]),
  reviewing: {
    groups: listings.reviewing.map(groupOf),
    problem:
      listings.reviewingProblem === null ? undefined : describeError(listings.reviewingProblem),
    notRefreshed: undefined,
  },
})

const CACHE_IDLE_TTL = "5 minutes"

const listingsAtom = backendRuntime
  .atom((get) => {
    get(followedRepositoriesRevisionAtom)
    get(reviewingRevisionAtom)

    const load = (known: Option.Option<Listings>) =>
      Backend.use((backend) => backend.ListPullRequests()).pipe(
        Effect.map(listingsOf),
        Effect.catchCause((cause) =>
          Option.match(known, {
            onNone: () => Effect.failCause(cause),
            onSome: (lists): Effect.Effect<Listings> => {
              const problem = problemOf(cause)

              return Effect.succeed(
                Record.map(lists, (listing) => ({
                  ...listing,
                  groups: listing.groups.map(markNotRefreshed(problem)),
                  notRefreshed: problem,
                })),
              )
            },
          }),
        ),
      )

    const known = get
      .self<AsyncResult.AsyncResult<Listings, BackendError>>()
      .pipe(Option.flatMap(AsyncResult.value))

    if (Option.isSome(known)) return load(known)

    return Effect.gen(function* () {
      const saved = yield* Backend.use((backend) => backend.ListSavedPullRequests()).pipe(
        Effect.map((listings) => Option.map(Option.fromNullOr(listings), listingsOf)),
        Effect.orElseSucceed(() => Option.none<Listings>()),
      )

      if (Option.isSome(saved)) get.setSelf(AsyncResult.success(saved.value, { waiting: true }))

      return yield* load(saved)
    })
  })
  .pipe(Atom.setIdleTTL(CACHE_IDLE_TTL))

const watchedListingsAtom = watched(listingsAtom)

export function PullRequestListPage(props: {
  search: ListSearch
  onSearch: (search: ListSearch) => void
  onOpen: (pullRequest: PullRequestRef) => void
}) {
  const listings = useAtomValue(watchedListingsAtom)

  const queue = useAtomValue(queueRefreshAtom)

  const refreshListings = useAtomRefresh(watchedListingsAtom)

  const refreshQueue = useAtomRefresh(queueRefreshAtom)

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
      <div className="page-content flex flex-col py-6">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">Reviews</h1>
          {props.search.list !== "queue" && <NotRefreshedNote list={props.search.list} />}
          <span className="ml-auto flex items-center gap-2">
            <PullRequestUrlForm onOpen={props.onOpen} />
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
              results={[listings, queue]}
              onRefresh={() => {
                refreshListings()
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
  const result = useAtomValue(watchedListingsAtom)

  if (!AsyncResult.isSuccess(result)) return null

  const { notRefreshed } = result.value[props.list]

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
  const result = useAtomValue(watchedListingsAtom)

  const refresh = useAtomRefresh(watchedListingsAtom)

  if (AsyncResult.isSuccess(result)) {
    const { groups, problem, notRefreshed } = result.value[props.tab.list]

    return (
      <LoadedList
        groups={groups}
        problem={problem}
        failed={notRefreshed !== undefined}
        view={props.view}
        emptyTitle={props.tab.emptyTitle}
        emptyBody={props.tab.emptyBody}
        onRefresh={refresh}
        onOpen={props.onOpen}
      />
    )
  }

  if (AsyncResult.isFailure(result) && !result.waiting) {
    return (
      <div className="py-4">
        <ProblemAlert problem={problemOf(result.cause)} action={{ label: "Retry", run: refresh }} />
      </div>
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

import type { PullRequestRef } from "@glass/contracts"
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Navigate,
  notFound,
  Outlet,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router"
import { Option, Schema } from "effect"
import { AsyncResult, type AtomRegistry } from "effect/reactivity"
import type { ReactNode } from "react"
import { AppShell } from "./AppShell"
import { Dashboard } from "./Dashboard"
import { Connecting, ConnectionProblem } from "./ConnectionProblem"
import { useConnection } from "./connection"
import { Viewed, viewedAtom } from "./globalChat"
import { answerBrowserPageRequests } from "./answerBrowserPageRequests"
import { openNewCheckIns } from "./openNewCheckIns"
import {
  closePullRequest,
  decodePullRequestParams,
  defaultListSearch,
  ListSearch,
  listSearchAtom,
  openPullRequest,
} from "./reviewsArea"

const ActivityLogPage = lazyRouteComponent(() => import("./ActivityLogPage"), "ActivityLogPage")

const CheckInPage = lazyRouteComponent(() => import("./CheckInPage"), "CheckInPage")

const ThreadsLayout = lazyRouteComponent(() => import("./Threads"), "ThreadsLayout")

const Inbox = lazyRouteComponent(() => import("./Inbox"), "Inbox")

const NewThread = lazyRouteComponent(() => import("./NewThread"), "NewThread")

const PullRequestListPage = lazyRouteComponent(
  () => import("./PullRequestListPage"),
  "PullRequestListPage",
)

const PullRequestPage = lazyRouteComponent(() => import("./PullRequestPage"), "PullRequestPage")

const Settings = lazyRouteComponent(() => import("./Settings"), "Settings")

const ToDos = lazyRouteComponent(() => import("./ToDos"), "ToDos")

const preloadLazyPage = (page: { preload?: () => Promise<void> | undefined }) => () =>
  page.preload?.()

const parseSearch = (search: string) => Object.fromEntries(new URLSearchParams(search))

const stringifySearch = (search: Readonly<Record<string, string>>) => {
  const params = new URLSearchParams(search).toString()

  return params === "" ? "" : `?${params}`
}

const rootRoute = createRootRouteWithContext<{ registry: AtomRegistry.AtomRegistry }>()({
  component: AppShell,
  notFoundComponent: () => <Navigate to="/reviews" search={defaultListSearch} replace />,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/dashboard", replace: true })
  },
})

const reviewsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "reviews",
  component: ReviewsLayout,
})

const listRoute = createRoute({
  getParentRoute: () => reviewsRoute,
  path: "/",
  validateSearch: Schema.toStandardSchemaV1(ListSearch),
  search: { middlewares: [stripSearchParams(defaultListSearch)] },
  beforeLoad: ({ context: { registry }, search, preload }) => {
    if (!preload) registry.set(listSearchAtom, search)
  },
  onEnter: ({ context: { registry } }) => closePullRequest(registry),
  loader: preloadLazyPage(PullRequestListPage),
  component: ListPage,
})

const pullRequestRoute = createRoute({
  getParentRoute: () => reviewsRoute,
  path: "$owner/$repo/$number",
  params: {
    parse: (params) => Option.getOrThrowWith(decodePullRequestParams(params), () => notFound()),
    stringify: ({ owner, repo, number }: PullRequestRef) => ({
      owner,
      repo,
      number: String(number),
    }),
  },
  beforeLoad: ({ context: { registry }, params, preload }) => {
    if (!preload) openPullRequest(registry, params)
  },
  component: PullRequestPage,
})

const toDosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "to-dos",
  loader: preloadLazyPage(ToDos),
  component: ToDosPage,
})

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "activity",
  loader: preloadLazyPage(ActivityLogPage),
  component: ActivityArea,
})

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "inbox",
  loader: preloadLazyPage(Inbox),
  component: () => (
    <main aria-label="Inbox" className="flex min-h-0 flex-1 overflow-hidden">
      <Inbox />
    </main>
  ),
})

const checkInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "inbox/check-ins/$checkInId",
  loader: preloadLazyPage(CheckInPage),
  component: function CheckInRoute() {
    const { checkInId } = checkInRoute.useParams()

    return <CheckInPage key={checkInId} checkInId={checkInId} />
  },
})

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dashboard",
  component: () => (
    <AreaPage label="Dashboard">
      <Dashboard />
    </AreaPage>
  ),
})

const threadsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "threads",
  component: ThreadsLayout,
})

const noThreadRoute = createRoute({
  getParentRoute: () => threadsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/threads/new", replace: true })
  },
})

const newThreadRoute = createRoute({
  getParentRoute: () => threadsRoute,
  path: "new",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ repository: Schema.optional(Schema.String) }),
  ),
  loader: preloadLazyPage(NewThread),
  component: NewThreadPage,
})

const threadRoute = createRoute({
  getParentRoute: () => threadsRoute,
  path: "$threadId",
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
  loader: preloadLazyPage(Settings),
  component: SettingsPage,
})

const routeTree = rootRoute.addChildren([
  indexRoute,
  reviewsRoute.addChildren([listRoute, pullRequestRoute]),
  toDosRoute,
  activityRoute,
  inboxRoute,
  checkInRoute,
  dashboardRoute,
  threadsRoute.addChildren([noThreadRoute, newThreadRoute, threadRoute]),
  settingsRoute,
])

const viewedIn = (router: ReturnType<typeof makeRouter>): Viewed | null => {
  for (const match of router.state.matches) {
    if (match.routeId === pullRequestRoute.id) return Viewed.PullRequest({ ref: match.params })

    if (match.routeId === threadRoute.id) return Viewed.Thread({ threadId: match.params.threadId })
  }

  return null
}

const makeRouter = (registry: AtomRegistry.AtomRegistry) =>
  createRouter({
    routeTree,
    history: createHashHistory(),
    context: { registry },
    defaultPreload: "intent",
    parseSearch,
    stringifySearch,
  })

export const createAppRouter = (registry: AtomRegistry.AtomRegistry) => {
  const router = makeRouter(registry)

  router.subscribe("onResolved", () => registry.set(viewedAtom, viewedIn(router)))
  answerBrowserPageRequests(registry)
  openNewCheckIns(registry, (checkInId) => {
    void window.glass.bringToFront()
    void router.navigate({ to: "/inbox/check-ins/$checkInId", params: { checkInId } })
  })

  return router
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof makeRouter>
  }
}

function ReviewsLayout() {
  const { result, retry } = useConnection()

  return (
    <main aria-label="Reviews" className="flex min-h-0 flex-1 flex-col">
      {AsyncResult.builder(result)
        .onSuccess(() => <Outlet />)
        .onFailure((cause, failure) => (
          <ConnectionProblem cause={cause} checking={failure.waiting} onRetry={retry} />
        ))
        .onInitial(() => <Connecting />)
        .render()}
    </main>
  )
}

function ListPage() {
  const search = listRoute.useSearch()
  const navigate = listRoute.useNavigate()

  return (
    <PullRequestListPage
      search={search}
      onSearch={(next) => void navigate({ search: next, replace: true })}
      onOpen={(ref) => void navigate({ to: "/reviews/$owner/$repo/$number", params: ref })}
    />
  )
}

function NewThreadPage() {
  const { repository } = newThreadRoute.useSearch()

  return <NewThread repository={repository} />
}

function ToDosPage() {
  return (
    <AreaPage label="To-dos">
      <ToDos />
    </AreaPage>
  )
}

function ActivityArea() {
  return (
    <AreaPage label="Activity">
      <ActivityLogPage />
    </AreaPage>
  )
}

function SettingsPage() {
  return (
    <AreaPage label="Settings">
      <Settings />
    </AreaPage>
  )
}

function AreaPage(props: { label: string; children: ReactNode }) {
  return (
    <main
      aria-label={props.label}
      className="relative min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]"
    >
      {props.children}
    </main>
  )
}

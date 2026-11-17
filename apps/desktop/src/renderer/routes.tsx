import type { PullRequestRef } from "@glass/contracts"
import {
  createHashHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Navigate,
  notFound,
  Outlet,
  redirect,
  stripSearchParams,
} from "@tanstack/react-router"
import { Option, Schema } from "effect"
import { AsyncResult, type AtomRegistry } from "effect/reactivity"
import type { ReactNode } from "react"
import { ActivityLogPage } from "./ActivityLogPage"
import { ConversationsLayout } from "./Conversations"
import { ConversationSearch } from "./conversationsArea"
import { ConversationView } from "./ConversationView"
import { AppShell } from "./AppShell"
import { Dashboard } from "./Dashboard"
import { CheckInPage } from "./CheckInPage"
import { Inbox } from "./Inbox"
import { Connecting, ConnectionProblem } from "./ConnectionProblem"
import { useConnection } from "./connection"
import { Viewed, viewedAtom } from "./globalConversation"
import { NewConversation } from "./NewConversation"
import { PullRequestListPage } from "./PullRequestListPage"
import { PullRequestPage } from "./PullRequestPage"
import {
  closePullRequest,
  decodePullRequestParams,
  defaultListSearch,
  ListSearch,
  listSearchAtom,
  openPullRequest,
} from "./reviewsArea"
import { Settings } from "./Settings"
import { ToDos } from "./ToDos"

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
  beforeLoad: ({ context: { registry }, search }) => registry.set(listSearchAtom, search),
  onEnter: ({ context: { registry } }) => closePullRequest(registry),
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
  beforeLoad: ({ context: { registry }, params }) => openPullRequest(registry, params),
  component: PullRequestPage,
})

const toDosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "to-dos",
  component: ToDosPage,
})

const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "activity",
  component: ActivityArea,
})

const inboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "inbox",
  component: () => (
    <main aria-label="Inbox" className="flex min-h-0 flex-1 overflow-hidden">
      <Inbox />
    </main>
  ),
})

const checkInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "inbox/check-ins/$checkInId",
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

const conversationsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "conversations",
  component: ConversationsLayout,
})

const noConversationRoute = createRoute({
  getParentRoute: () => conversationsRoute,
  path: "/",
  beforeLoad: () => {
    throw redirect({ to: "/conversations/new", replace: true })
  },
})

const newConversationRoute = createRoute({
  getParentRoute: () => conversationsRoute,
  path: "new",
  validateSearch: Schema.toStandardSchemaV1(
    Schema.Struct({ repository: Schema.optional(Schema.String) }),
  ),
  component: NewConversationPage,
})

const conversationRoute = createRoute({
  getParentRoute: () => conversationsRoute,
  path: "$conversationId",
  validateSearch: Schema.toStandardSchemaV1(ConversationSearch),
  component: ConversationPage,
})

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "settings",
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
  conversationsRoute.addChildren([noConversationRoute, newConversationRoute, conversationRoute]),
  settingsRoute,
])

const viewedIn = (router: ReturnType<typeof makeRouter>): Viewed | null => {
  for (const match of router.state.matches) {
    if (match.routeId === pullRequestRoute.id) return Viewed.PullRequest({ ref: match.params })

    if (match.routeId === conversationRoute.id)
      return Viewed.Conversation({ conversationId: match.params.conversationId })
  }

  return null
}

const makeRouter = (registry: AtomRegistry.AtomRegistry) =>
  createRouter({
    routeTree,
    history: createHashHistory(),
    context: { registry },
    parseSearch,
    stringifySearch,
  })

export const createAppRouter = (registry: AtomRegistry.AtomRegistry) => {
  const router = makeRouter(registry)

  router.subscribe("onResolved", () => registry.set(viewedAtom, viewedIn(router)))

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

function NewConversationPage() {
  const { repository } = newConversationRoute.useSearch()

  return <NewConversation repository={repository} />
}

function ConversationPage() {
  const { conversationId } = conversationRoute.useParams()
  const { view } = conversationRoute.useSearch()
  const navigate = conversationRoute.useNavigate()

  return (
    <ConversationView
      conversationId={conversationId}
      tab={view ?? "chat"}
      onTabChange={(tab) => void navigate({ search: tab === "changes" ? { view: tab } : {} })}
    />
  )
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

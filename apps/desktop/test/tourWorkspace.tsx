import { RegistryProvider } from "@effect/atom-react"
import {
  type AgentReviewState,
  type ChangedFile,
  GitHubConnection,
  type TourState,
} from "@glass/contracts"
import { act, cleanup, render, screen, within } from "@testing-library/react"
import userEvent, { PointerEventsCheckLevel } from "@testing-library/user-event"
import { Effect, Stream, SubscriptionRef } from "effect"
import { vi } from "vite-plus/test"
import { App } from "../src/renderer/App"
import { backendLayerAtom } from "../src/renderer/backend"
import { type Handlers, testLayer } from "./testBackend"
import { workspace } from "./workspace"

export const resetTourWorkspace = () => {
  cleanup()
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "#/")
}

export const mountTourWorkspace = (
  options: {
    readonly files?: ReadonlyArray<ChangedFile>
    readonly viewedPaths?: ReadonlyArray<string>
    readonly initial?: TourState
    readonly agentReview?: AgentReviewState
  } = {},
) => {
  // happy-dom lays nothing out; give each diff scroller a viewport so its files render.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const panel = this.parentElement

    return (this.classList.contains("overflow-auto") &&
      this.closest('[aria-label="Tour Chapters"]') !== null) ||
      (panel?.getAttribute("role") === "tabpanel" && panel.lastElementChild === this)
      ? new DOMRect(0, 0, 1000, 10_000)
      : new DOMRect()
  })

  const state = Effect.runSync(
    SubscriptionRef.make<TourState>(options.initial ?? { tour: null, job: { status: "idle" } }),
  )

  const startedAt = Date.now() - 3000

  const write = vi.fn<Handlers["WriteTour"]>(() =>
    SubscriptionRef.update(state, ({ tour }): TourState => ({
      tour,
      job: { status: "writing", startedAt, runner: null },
    })),
  )

  const cancel = vi.fn<Handlers["CancelTour"]>(() =>
    SubscriptionRef.update(state, ({ tour }): TourState => ({ tour, job: { status: "idle" } })),
  )

  const setViewed = vi.fn<Handlers["SetFileViewed"]>(() => Effect.void)

  const backend = testLayer({
    GetConnection: () =>
      Effect.succeed(new GitHubConnection({ login: "kevin", tokenSource: "gh" })),
    OpenPullRequest: () =>
      Effect.succeed(
        workspace([], { files: options.files ?? [], viewedPaths: options.viewedPaths ?? [] }),
      ),
    RecordActivity: () => Effect.void,
    HasPullRequestChanged: () => Effect.succeed(false),
    SetFileViewed: setViewed,
    WriteTour: write,
    CancelTour: cancel,
    WatchTour: () => SubscriptionRef.changes(state),
    WatchAgentReview: () =>
      Stream.make(options.agentReview ?? { review: null, job: { status: "idle" } }),
  })

  window.history.replaceState(null, "", "#/reviews/octo-org/hello-world/42")
  render(
    <RegistryProvider initialValues={[[backendLayerAtom, backend]]}>
      <App />
    </RegistryProvider>,
  )

  return {
    write,
    cancel,
    setViewed,
    startedAt,
    user: userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never }),
    publish: (next: TourState) =>
      act(async () => {
        await Effect.runPromise(SubscriptionRef.set(state, next))
      }),
  }
}

export const changes = () => screen.getByRole("tabpanel", { name: "Changes" })

export const fileOrder = () =>
  within(changes())
    .getAllByRole("checkbox", { name: /^Viewed: / })
    .map((box) => box.getAttribute("aria-label")!.slice("Viewed: ".length))

export const chapter = (name: string) => within(changes()).getByRole("region", { name })

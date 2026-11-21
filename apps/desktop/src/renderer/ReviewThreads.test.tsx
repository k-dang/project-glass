// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { GitHubUnavailable, LineReviewThread, PublishedComment } from "@glass/contracts"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { ReviewThread } from "./ReviewThreads"
import { ReplyStore } from "./useReplies"
import { createReactions } from "./useReactions"
import { createResolutions } from "./useResolutions"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"
import { recordedPullRequest } from "../../test/workspace"

const reviewThread = (resolved: boolean) =>
  new LineReviewThread({
    id: "T1",
    path: "greet.ts",
    side: "new",
    line: 2,
    resolved,
    comments: [
      new PublishedComment({
        id: "C1",
        author: "hubot",
        avatarUrl: null,
        bodyHtml: "<p>Why there?</p>",
        createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
        reactions: [],
      }),
    ],
  })

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

const renderReviewThread = (resolved: boolean) => {
  const calls: Array<
    Held<{ reviewThreadId: string; resolved: boolean }, boolean, GitHubUnavailable>
  > = []

  const registry = testRegistry({ SetReviewThreadResolved: hold(calls) })

  registries.push(registry)

  const resolutions = createResolutions(registry)

  render(
    <RegistryContext.Provider value={registry}>
      <ReviewThread
        reviewThread={reviewThread(resolved)}
        replies={new ReplyStore(registry, recordedPullRequest, () => {})}
        resolutions={resolutions}
        reactions={createReactions(registry)}
      />
    </RegistryContext.Provider>,
  )

  return { calls, resolutions }
}

const offline = () => new GitHubUnavailable({ message: "Offline" })

it("keeps an unresolved Review thread unresolved until GitHub confirms, then retries a failed resolve", async () => {
  const { calls } = renderReviewThread(false)
  const user = userEvent.setup()
  const resolve = { name: "Resolve Review thread on greet.ts line +2" }

  expect(screen.getByText(/Unresolved Review thread/)).toBeTruthy()
  await user.click(screen.getByRole("button", resolve))

  const failed = await next(calls)

  expect(failed.payload).toEqual({ reviewThreadId: "T1", resolved: true })
  expect(screen.getByText("Resolving…")).toBeTruthy()
  expect(screen.getByText(/Unresolved Review thread/)).toBeTruthy()
  failed.answer(Effect.fail(offline()))

  await screen.findByText(/Couldn't resolve this Review thread/)
  expect(screen.getByText(/Unresolved Review thread/)).toBeTruthy()
  expect(screen.queryByRole("button", resolve)).toBeNull()

  await user.click(
    screen.getByRole("button", { name: "Retry resolving Review thread on greet.ts line +2" }),
  )
  const retry = await next(calls)

  expect(retry.payload).toEqual({ reviewThreadId: "T1", resolved: true })
  expect(screen.getByText("Resolving…")).toBeTruthy()
  retry.answer(Effect.succeed(true))

  await screen.findByRole("button", { name: "Unresolve Review thread on greet.ts line +2" })
  expect(screen.getByText(/Resolved Review thread/)).toBeTruthy()
  expect(screen.queryByText(/Couldn't resolve this Review thread/)).toBeNull()
})

it("unresolves a resolved Review thread, and a failed unresolve leaves it resolved", async () => {
  const { calls } = renderReviewThread(true)
  const user = userEvent.setup()
  const unresolve = { name: "Unresolve Review thread on greet.ts line +2" }

  await user.click(screen.getByRole("button", unresolve))
  const failed = await next(calls)

  expect(failed.payload).toEqual({ reviewThreadId: "T1", resolved: false })
  expect(screen.getByText("Unresolving…")).toBeTruthy()
  expect(screen.getByText(/Resolved Review thread/)).toBeTruthy()
  failed.answer(Effect.fail(offline()))

  await screen.findByText(/Couldn't unresolve this Review thread/)
  expect(screen.getByText(/Resolved Review thread/)).toBeTruthy()

  await user.click(
    screen.getByRole("button", { name: "Retry unresolving Review thread on greet.ts line +2" }),
  )
  const retry = await next(calls)

  expect(retry.payload).toEqual({ reviewThreadId: "T1", resolved: false })
  retry.answer(Effect.succeed(false))

  await screen.findByRole("button", { name: "Resolve Review thread on greet.ts line +2" })
  expect(screen.getByText(/Unresolved Review thread/)).toBeTruthy()
  expect(screen.queryByText(/Couldn't unresolve this Review thread/)).toBeNull()
})

it("shows the resolved state GitHub reports, even when that is not the state asked for", async () => {
  const { calls } = renderReviewThread(false)
  const user = userEvent.setup()

  await user.click(
    screen.getByRole("button", { name: "Resolve Review thread on greet.ts line +2" }),
  )
  const resolve = await next(calls)

  resolve.answer(Effect.succeed(false))

  await waitFor(() => expect(screen.queryByText("Resolving…")).toBeNull())
  expect(screen.getByText(/Unresolved Review thread/)).toBeTruthy()
  expect(
    screen.getByRole("button", { name: "Resolve Review thread on greet.ts line +2" }),
  ).toBeTruthy()
  expect(screen.queryByText(/Couldn't resolve this Review thread/)).toBeNull()
})

it("ignores duplicate writes to the same Review thread while other Review threads can resolve", async () => {
  const { calls, resolutions } = renderReviewThread(false)

  resolutions.set("T1", true)
  const first = await next(calls)
  resolutions.set("T1", false)
  resolutions.set("T2", true)

  expect((await next(calls)).payload).toEqual({ reviewThreadId: "T2", resolved: true })
  expect(calls).toHaveLength(0)
  first.answer(Effect.succeed(true))

  await screen.findByRole("button", { name: "Unresolve Review thread on greet.ts line +2" })
})

// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { GitHubUnavailable, LineDiscussion, PublishedComment } from "@glass/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { eventually } from "../../test/eventually"
import { DiscussionThread } from "./Discussions"
import { ReplyStore } from "./useReplies"
import { createResolutions } from "./useResolutions"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"
import { recordedPullRequest } from "../../test/workspace"

const discussion = (resolved: boolean) =>
  new LineDiscussion({
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
      }),
    ],
  })

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

const renderThread = (resolved: boolean) => {
  const calls: Array<
    Held<{ discussionId: string; resolved: boolean }, boolean, GitHubUnavailable>
  > = []

  const registry = testRegistry({ SetDiscussionResolved: hold(calls) })

  registries.push(registry)

  const resolutions = createResolutions(registry)

  render(
    <RegistryContext.Provider value={registry}>
      <DiscussionThread
        discussion={discussion(resolved)}
        replies={new ReplyStore(registry, recordedPullRequest, () => {})}
        resolutions={resolutions}
      />
    </RegistryContext.Provider>,
  )

  return { calls, resolutions }
}

const offline = () => new GitHubUnavailable({ message: "Offline" })

it("keeps an unresolved Discussion unresolved until GitHub confirms, then retries a failed resolve", async () => {
  const { calls } = renderThread(false)
  const user = userEvent.setup()
  const resolve = { name: "Resolve thread on greet.ts line +2" }

  expect(screen.getByText(/Unresolved thread/)).toBeTruthy()
  await user.click(screen.getByRole("button", resolve))

  const failed = await next(calls)

  expect(failed.payload).toEqual({ discussionId: "T1", resolved: true })
  expect(screen.getByText("Resolving…")).toBeTruthy()
  expect(screen.getByText(/Unresolved thread/)).toBeTruthy()
  failed.answer(Effect.fail(offline()))

  await screen.findByText(/Couldn't resolve this Discussion/)
  expect(screen.getByText(/Unresolved thread/)).toBeTruthy()
  expect(screen.queryByRole("button", resolve)).toBeNull()

  await user.click(
    screen.getByRole("button", { name: "Retry resolving thread on greet.ts line +2" }),
  )
  const retry = await next(calls)

  expect(retry.payload).toEqual({ discussionId: "T1", resolved: true })
  expect(screen.getByText("Resolving…")).toBeTruthy()
  retry.answer(Effect.succeed(true))

  await screen.findByRole("button", { name: "Unresolve thread on greet.ts line +2" })
  expect(screen.getByText(/Resolved thread/)).toBeTruthy()
  expect(screen.queryByText(/Couldn't resolve this Discussion/)).toBeNull()
})

it("unresolves a resolved Discussion, and a failed unresolve leaves it resolved", async () => {
  const { calls } = renderThread(true)
  const user = userEvent.setup()
  const unresolve = { name: "Unresolve thread on greet.ts line +2" }

  await user.click(screen.getByRole("button", unresolve))
  const failed = await next(calls)

  expect(failed.payload).toEqual({ discussionId: "T1", resolved: false })
  expect(screen.getByText("Unresolving…")).toBeTruthy()
  expect(screen.getByText(/Resolved thread/)).toBeTruthy()
  failed.answer(Effect.fail(offline()))

  await screen.findByText(/Couldn't unresolve this Discussion/)
  expect(screen.getByText(/Resolved thread/)).toBeTruthy()

  await user.click(
    screen.getByRole("button", { name: "Retry unresolving thread on greet.ts line +2" }),
  )
  const retry = await next(calls)

  expect(retry.payload).toEqual({ discussionId: "T1", resolved: false })
  retry.answer(Effect.succeed(false))

  await screen.findByRole("button", { name: "Resolve thread on greet.ts line +2" })
  expect(screen.getByText(/Unresolved thread/)).toBeTruthy()
  expect(screen.queryByText(/Couldn't unresolve this Discussion/)).toBeNull()
})

it("shows the resolved state GitHub reports, even when that is not the state asked for", async () => {
  const { calls } = renderThread(false)
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "Resolve thread on greet.ts line +2" }))
  const resolve = await next(calls)

  resolve.answer(Effect.succeed(false))

  await eventually(() => expect(screen.queryByText("Resolving…")).toBeNull())
  expect(screen.getByText(/Unresolved thread/)).toBeTruthy()
  expect(screen.getByRole("button", { name: "Resolve thread on greet.ts line +2" })).toBeTruthy()
  expect(screen.queryByText(/Couldn't resolve this Discussion/)).toBeNull()
})

it("ignores duplicate writes to the same Discussion while other Discussions can resolve", async () => {
  const { calls, resolutions } = renderThread(false)

  resolutions.set("T1", true)
  const first = await next(calls)
  resolutions.set("T1", false)
  resolutions.set("T2", true)

  expect((await next(calls)).payload).toEqual({ discussionId: "T2", resolved: true })
  expect(calls).toHaveLength(0)
  first.answer(Effect.succeed(true))

  await screen.findByRole("button", { name: "Unresolve thread on greet.ts line +2" })
})

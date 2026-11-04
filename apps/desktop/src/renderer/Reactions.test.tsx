// @vitest-environment happy-dom
import { RegistryContext } from "@effect/atom-react"
import { GitHubUnavailable, PublishedComment, ReactionGroup } from "@glass/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { DateTime, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { CommentReactions } from "./Reactions"
import { createReactions, type ReactionChange } from "./useReactions"
import { type Held, hold, next, testRegistry } from "../../test/testBackend"

const registries: Array<ReturnType<typeof testRegistry>> = []

afterEach(() => {
  cleanup()

  for (const registry of registries.splice(0)) registry.dispose()
})

const renderReactions = () => {
  const calls: Array<
    Held<ReactionChange & { commentId: string }, ReadonlyArray<ReactionGroup>, GitHubUnavailable>
  > = []

  const registry = testRegistry({ SetReaction: hold(calls) })

  registries.push(registry)

  const comment = new PublishedComment({
    id: "C1",
    author: "hubot",
    avatarUrl: null,
    bodyHtml: "<p>Why there?</p>",
    createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
    reactions: [new ReactionGroup({ reaction: "thumbs-up", count: 1, reacted: false })],
  })

  render(
    <RegistryContext.Provider value={registry}>
      <CommentReactions store={createReactions(registry)} comment={comment} />
    </RegistryContext.Provider>,
  )

  return calls
}

it("adds to a Reaction someone gave, and shows GitHub's count once it confirms", async () => {
  const calls = renderReactions()
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "thumbs up: 1" }))
  const call = await next(calls)

  expect(call.payload).toEqual({ commentId: "C1", reaction: "thumbs-up", reacted: true })
  expect(screen.getByRole("button", { name: "thumbs up: 1" })).toHaveProperty("disabled", true)
  call.answer(
    Effect.succeed([new ReactionGroup({ reaction: "thumbs-up", count: 2, reacted: true })]),
  )

  expect(await screen.findByRole("button", { name: "thumbs up: 2, including you" })).toBeTruthy()
})

it("picks a new Reaction, and retries one GitHub refused", async () => {
  const calls = renderReactions()
  const user = userEvent.setup()

  await user.click(screen.getByRole("button", { name: "React to hubot's comment" }))
  await user.click(await screen.findByRole("button", { name: "rocket" }))
  const failed = await next(calls)

  expect(failed.payload).toEqual({ commentId: "C1", reaction: "rocket", reacted: true })
  failed.answer(Effect.fail(new GitHubUnavailable({ message: "Offline" })))

  await screen.findByText(/Couldn't add your rocket/)
  await user.click(screen.getByRole("button", { name: "Retry" }))
  const retry = await next(calls)

  expect(retry.payload).toEqual(failed.payload)
  retry.answer(
    Effect.succeed([
      new ReactionGroup({ reaction: "thumbs-up", count: 1, reacted: false }),
      new ReactionGroup({ reaction: "rocket", count: 1, reacted: true }),
    ]),
  )

  expect(await screen.findByRole("button", { name: "rocket: 1, including you" })).toBeTruthy()
  expect(screen.queryByText(/Couldn't add your rocket/)).toBeNull()
})

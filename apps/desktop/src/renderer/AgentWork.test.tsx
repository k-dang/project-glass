// @vitest-environment happy-dom
import { AgentReviewFailure, Revision } from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { AgentWork } from "./AgentWork"
import type { useTour } from "./useTour"
import type { AgentReviewControls } from "./useAgentReview"
import { controls, reviewOf } from "../../test/agentReview"

afterEach(cleanup)

const noTour: ReturnType<typeof useTour> = {
  latest: { tour: null, job: { status: "idle" } },
  saved: null,
  writing: false,
  outdated: null,
  subscriptionProblem: null,
  commandFailure: null,
  pending: false,
  reconnect: vi.fn<() => void>(),
  write: vi.fn<() => void>(),
  cancel: vi.fn<() => void>(),
}

const open = async (review: AgentReviewControls, onRead = vi.fn<() => void>()) => {
  render(
    <AgentWork
      tour={noTour}
      reading={null}
      review={review}
      onReadTour={vi.fn<() => void>()}
      onReadReview={onRead}
    />,
  )
  await userEvent.click(screen.getByRole("button", { name: "Agent work" }))

  return within(await screen.findByRole("listitem", { name: "Agent review" }))
}

const trigger = () => screen.getByRole("button", { name: "Agent work" })

it("shows a running review's elapsed time on the trigger and cancels it from the menu", async () => {
  const running = controls({
    job: { status: "reviewing", startedAt: Date.now() - 65_000, runner: null },
  })

  const row = await open(running)

  expect(within(trigger()).getByLabelText("Time elapsed").textContent).toBe("1:05")
  await userEvent.click(row.getByRole("button", { name: "Cancel" }))
  expect(running.cancel).toHaveBeenCalledOnce()
})

it("says why a review failed and tries again", async () => {
  const message = "Fetching the PR's code took too long. Try again."

  const failed = controls({
    job: {
      status: "failed",
      reason: new AgentReviewFailure({ reason: "fetch-failed", message, runner: null }),
    },
  })

  const row = await open(failed)

  expect(trigger().textContent).toContain("Review failed")
  expect(row.getByText(message)).toBeDefined()
  await userEvent.click(row.getByRole("button", { name: "Try again" }))
  expect(failed.start).toHaveBeenCalledOnce()
})

it("offers Reconnect instead of a stale running review when its updates stop", async () => {
  const lost = controls({
    job: { status: "reviewing", startedAt: Date.now(), runner: null },
    subscriptionProblem: { title: "Lost connection", detail: "Glass stopped getting updates." },
  })

  const row = await open(lost)

  expect(row.getByText("Glass stopped getting updates.")).toBeDefined()
  expect(row.queryByRole("button", { name: "Cancel" })).toBeNull()
  await userEvent.click(row.getByRole("button", { name: "Reconnect" }))
  expect(lost.reconnect).toHaveBeenCalledOnce()
})

const review = reviewOf(new Revision({ base: "b", head: "0123456789abcdef" }))

it("reads a saved review", async () => {
  const onRead = vi.fn<() => void>()
  const row = await open(controls({ review }), onRead)

  await userEvent.click(row.getByRole("button", { name: "Read" }))
  expect(onRead).toHaveBeenCalledOnce()
})

it("says which head an outdated review was written for and reviews again", async () => {
  const outdated = controls({ review, outdated: true })
  const row = await open(outdated)

  expect(row.getByText(/Written for head/).textContent).toBe("Written for head 0123456")
  await userEvent.click(row.getByRole("button", { name: "Review again" }))
  expect(outdated.start).toHaveBeenCalledOnce()
})

it("says why a closed PR can't start a review", async () => {
  const row = await open(controls({ start: null, closedAs: "closed" }))

  expect(row.getByText("Agent reviews are for open PRs, and this one is closed.")).toBeDefined()
  expect(row.queryByRole("button")).toBeNull()
})

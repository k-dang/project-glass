// @vitest-environment happy-dom
import { AgentReviewFailure, Revision } from "@glass/contracts"
import { cleanup, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { AgentReviewBanner } from "./AgentReview"
import { controls, reviewOf } from "../../test/agentReview"

afterEach(cleanup)

it("shows a running review with its elapsed time and Cancel", async () => {
  const running = controls({
    job: { status: "reviewing", startedAt: Date.now() - 65_000, runner: null },
  })

  render(<AgentReviewBanner controls={running} onRead={vi.fn<() => void>()} />)

  expect(screen.getByRole("status", { name: "Agent review" }).textContent).toContain(
    "Agent reviewing…",
  )
  expect(screen.getByLabelText("Time elapsed").textContent).toBe("65s")
  await userEvent.click(screen.getByRole("button", { name: "Cancel" }))
  expect(running.cancel).toHaveBeenCalledOnce()
})

it("says why a review failed and retries it", async () => {
  const message = "Fetching the PR's code took too long. Try again."

  const failed = controls({
    job: {
      status: "failed",
      reason: new AgentReviewFailure({ reason: "fetch-failed", message, runner: null }),
    },
  })

  render(<AgentReviewBanner controls={failed} onRead={vi.fn<() => void>()} />)

  expect(screen.getByText(message)).toBeDefined()
  await userEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(failed.start).toHaveBeenCalledOnce()
})

const review = reviewOf(new Revision({ base: "b", head: "0123456789abcdef" }))

it("links a finished review to its place beside the diff", async () => {
  const onRead = vi.fn<() => void>()
  render(<AgentReviewBanner controls={controls({ review })} onRead={onRead} />)

  expect(screen.getByRole("status", { name: "Agent review" }).textContent).toBe(
    "Agent review written·Read beside the diff",
  )
  await userEvent.click(screen.getByRole("button", { name: "Read beside the diff" }))
  expect(onRead).toHaveBeenCalledOnce()
})

it("says an Agent review for an older Revision is outdated and reviews again", async () => {
  const outdated = controls({ review, outdated: true })
  render(<AgentReviewBanner controls={outdated} onRead={vi.fn<() => void>()} />)

  expect(screen.getByRole("status", { name: "Agent review" }).textContent).toContain(
    "Outdated: written for an older Revision (head 0123456)",
  )
  await userEvent.click(screen.getByRole("button", { name: "Review again" }))
  expect(outdated.start).toHaveBeenCalledOnce()
})

it("keeps a running review in view when another command fails", () => {
  render(
    <AgentReviewBanner
      controls={controls({
        job: { status: "reviewing", startedAt: Date.now(), runner: null },
        commandProblem: { title: "Couldn't run the Agent review", detail: "Try again." },
      })}
      onRead={vi.fn<() => void>()}
    />,
  )

  expect(screen.getByRole("button", { name: "Cancel" })).toBeDefined()
})

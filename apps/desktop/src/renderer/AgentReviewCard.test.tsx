// @vitest-environment happy-dom
import { AgentReviewFailure, Revision } from "@glass/contracts"
import { cleanup, render, screen, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { controls, reviewOf } from "../../test/agentReview"
import { revision } from "../../test/workspace"
import { AgentReviewCard } from "./AgentReviewCard"

afterEach(cleanup)

const older = new Revision({ base: "b0", head: "0123456789abcdef" })

const mount = (overrides: Parameters<typeof controls>[0]) => {
  const given = controls(overrides)
  const onRead = vi.fn<() => void>()
  render(<AgentReviewCard controls={given} onRead={onRead} />)

  return {
    controls: given,
    onRead,
    card: screen.queryByRole("region", { name: "Agent review" }),
  }
}

it("shows only the review's opening and reads the rest beside the diff", async () => {
  const f = mount({ review: reviewOf(revision) })
  const card = within(f.card!)

  expect(card.getByText("The greeting changes a letter callers match on.")).toBeDefined()
  expect(card.queryByText("Callers expect the old letter")).toBeNull()
  await userEvent.click(card.getByRole("button", { name: "Read beside the diff" }))
  expect(f.onRead).toHaveBeenCalledOnce()
})

it("notes an outdated review and reviews again", async () => {
  const f = mount({ review: reviewOf(older), outdated: true })
  const card = within(f.card!)

  expect(card.getByRole("note").textContent).toContain(
    "Written for an older Revision (head 0123456), so it may not match the code.",
  )
  expect(card.getByText("The greeting changes a letter callers match on.")).toBeDefined()

  await userEvent.click(card.getByRole("button", { name: "Review again" }))
  expect(f.controls.start).toHaveBeenCalledOnce()
  cleanup()

  const rerunning = mount({
    review: reviewOf(older),
    outdated: true,
    job: { status: "reviewing", startedAt: Date.now(), runner: null },
  })

  expect(within(rerunning.card!).getByText("Agent reviewing…")).toBeDefined()
  expect(within(rerunning.card!).getByRole("note").textContent).toContain("older Revision")
  expect(within(rerunning.card!).queryByRole("button", { name: "Review again" })).toBeNull()
  cleanup()

  const rerunFailed = mount({
    review: reviewOf(older),
    outdated: true,
    job: {
      status: "failed",
      reason: new AgentReviewFailure({
        reason: "timeout",
        message: "Took too long.",
        runner: null,
      }),
    },
  })

  expect(within(rerunFailed.card!).getByText("Took too long.")).toBeDefined()
  expect(within(rerunFailed.card!).getByRole("note").textContent).toContain("older Revision")
})

it("offers to start a review, and only where one can start", async () => {
  const f = mount({})
  await userEvent.click(within(f.card!).getByRole("button", { name: "Start Agent review" }))
  expect(f.controls.start).toHaveBeenCalledOnce()
  cleanup()

  expect(mount({ start: null }).card).toBeNull()
  cleanup()

  const closedAndFailed = mount({
    start: null,
    job: {
      status: "failed",
      reason: new AgentReviewFailure({
        reason: "timeout",
        message: "Took too long.",
        runner: null,
      }),
    },
  })

  expect(within(closedAndFailed.card!).getByText("Took too long.")).toBeDefined()
  expect(within(closedAndFailed.card!).queryByRole("button", { name: "Retry" })).toBeNull()
})

it("shows a running review with Cancel and a failed one with Retry", async () => {
  const running = mount({ job: { status: "reviewing", startedAt: Date.now(), runner: null } })
  expect(within(running.card!).getByText("Agent reviewing…")).toBeDefined()
  await userEvent.click(within(running.card!).getByRole("button", { name: "Cancel" }))
  expect(running.controls.cancel).toHaveBeenCalledOnce()
  cleanup()

  const message = "Your GitHub Connection can't read this repository's code."

  const failed = mount({
    job: {
      status: "failed",
      reason: new AgentReviewFailure({ reason: "no-access", message, runner: null }),
    },
  })

  expect(within(failed.card!).getByText(message)).toBeDefined()
  await userEvent.click(within(failed.card!).getByRole("button", { name: "Retry" }))
  expect(failed.controls.start).toHaveBeenCalledOnce()
})

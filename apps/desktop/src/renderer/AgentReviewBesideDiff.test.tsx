// @vitest-environment happy-dom
import { Revision } from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vite-plus/test"
import { reviewOf } from "../../test/agentReview"
import { changes, mountTourWorkspace, resetTourWorkspace } from "../../test/tourWorkspace"
import { changedFile, revision, savedTour } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("greet.ts")]

const agentReviewTab = () => screen.getByRole("tab", { name: "Agent review" })

it("reads the whole Agent review in the file panel beside the diff", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  const card = await screen.findByRole("region", { name: "Agent review" })
  await f.user.click(within(card).getByRole("button", { name: "Read beside the diff" }))

  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
  expect(agentReviewTab().getAttribute("aria-selected")).toBe("true")
  const panel = await screen.findByRole("region", { name: "Agent review" })
  expect(within(panel).getByText("Callers expect the old letter")).toBeDefined()
})

it("leaves the Tour order, which hides the file panel, to read the Agent review", async () => {
  const f = mountTourWorkspace({
    files,
    initial: {
      tour: savedTour([
        {
          title: "Greet by name",
          explanation: "It takes a name.",
          files: [{ path: "greet.ts", summary: "Builds it." }],
        },
      ]),
      job: { status: "idle" },
    },
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  const tourOrder = await screen.findByRole("button", { name: "Tour" })
  expect(tourOrder.getAttribute("aria-pressed")).toBe("true")

  await f.user.click(within(changes()).getByRole("button", { name: "Read beside the diff" }))
  expect(tourOrder.getAttribute("aria-pressed")).toBe("false")
  expect(agentReviewTab().getAttribute("aria-selected")).toBe("true")
})

it("marks an outdated Agent review on Changes and still reads it", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: {
      review: reviewOf(new Revision({ base: "b0", head: "0123456789abcdef" })),
      job: { status: "idle" },
    },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))

  const banner = await waitFor(() =>
    within(changes()).getByRole("status", { name: "Agent review" }),
  )

  expect(banner.textContent).toContain("Outdated: written for an older Revision (head 0123456)")
  await f.user.click(within(banner).getByRole("button", { name: "Read beside the diff" }))
  expect(agentReviewTab().getAttribute("aria-selected")).toBe("true")
})

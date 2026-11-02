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

const followedUp = (reviewRevision: Revision) => ({
  ...reviewOf(reviewRevision),
  followUps: [
    {
      message: "Draft a comment for the letter change.",
      answer: "Here is one for `greet.ts`.",
      suggestedDrafts: [
        { path: "greet.ts", side: "new" as const, line: 2, body: "Callers match on `b`." },
      ],
    },
  ],
})

const readBesideTheDiff = async (f: ReturnType<typeof mountTourWorkspace>) => {
  const card = await screen.findByRole("region", { name: "Agent review" })
  await f.user.click(within(card).getByRole("button", { name: "Read beside the diff" }))
}

it("follows up on the Agent review from beside the diff, on the workspace's Revision", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  await readBesideTheDiff(f)
  await f.user.type(screen.getByRole("textbox", { name: "Follow up" }), "Is this blocking?{Enter}")

  await waitFor(() => expect(f.followUp).toHaveBeenCalledOnce())
  expect(f.followUp.mock.calls[0]?.[0]).toMatchObject({ revision, message: "Is this blocking?" })
})

it("adds a suggested Draft as the user edited it", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
  })

  await readBesideTheDiff(f)
  const suggested = screen.getByRole("region", { name: "Suggested draft on greet.ts line +2" })
  const body = within(suggested).getByRole("textbox")
  await f.user.clear(body)
  await f.user.type(body, "Do callers still match?")
  await f.user.click(within(suggested).getByRole("button", { name: "Add Draft" }))

  await waitFor(() => expect(f.createDraft).toHaveBeenCalledOnce())
  expect(f.createDraft.mock.calls[0]?.[0]).toMatchObject({
    path: "greet.ts",
    side: "new",
    line: 2,
    body: "Do callers still match?",
  })
  expect(within(suggested).getByText("You have a Draft on this line.")).toBeDefined()
})

it("only reads the Follow-ups of an outdated Agent review", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: {
      review: followedUp(new Revision({ base: "b0", head: "0123456789abcdef" })),
      job: { status: "idle" },
    },
  })

  await readBesideTheDiff(f)
  const panel = screen.getByRole("region", { name: "Agent review" })

  expect(within(panel).getByText(/Here is one for/)).toBeDefined()
  expect(
    screen.getByText("Written for an older Revision. Review again to follow up."),
  ).toBeDefined()
  expect(screen.queryByRole("textbox", { name: "Follow up" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Add Draft" })).toBeNull()
})

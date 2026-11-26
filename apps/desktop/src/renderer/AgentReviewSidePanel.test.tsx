// @vitest-environment happy-dom
import {
  AgentReviewTurn,
  Revision,
  SUGGEST_DRAFT_TOOL,
  type SuggestedDraft,
  TextPart,
  ToolCallPart,
  type Turn,
  TurnDone,
} from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { DateTime } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { reviewOf } from "../../test/agentReview"
import { mountTourWorkspace, openTourOrder, resetTourWorkspace } from "../../test/tourWorkspace"
import { changedFile, revision, savedTour } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("greet.ts")]

const sidePanel = () => screen.queryByRole("complementary", { name: "Agent review" })

const followedUp = (reviewRevision: Revision) => ({
  ...reviewOf(reviewRevision),
  threadId: "review-agent",
})

const suggestion = (input: SuggestedDraft, status: "done" | "failed") =>
  ToolCallPart.make({
    toolCallId: `call-${status}`,
    name: SUGGEST_DRAFT_TOOL,
    inputSummary: "greet.ts",
    input: JSON.stringify(input),
    output: status === "done" ? "Glass shows this Suggested draft." : "Not a line of the diff.",
    status,
    parentToolCallId: null,
  })

const sentAt = DateTime.makeUnsafe(0)

const reviewTurn: Turn = {
  id: "turn-0",
  message: 'PR material (JSON data):\n{"title":"Greet"}',
  images: [],
  context: AgentReviewTurn.make({}),
  feedback: [],
  sentAt,
  ended: { at: sentAt, ending: TurnDone.make({}) },
  parts: [TextPart.make({ text: "Handed in." })],
}

const followUps: ReadonlyArray<Turn> = [
  {
    id: "turn-1",
    message: "Draft a comment for the letter change.",
    images: [],
    context: null,
    feedback: [],
    sentAt,
    ended: { at: sentAt, ending: TurnDone.make({}) },
    parts: [
      suggestion({ path: "greet.ts", side: "new", line: 9, body: "Off the diff." }, "failed"),
      suggestion({ path: "greet.ts", side: "new", line: 2, body: "Callers match on `b`." }, "done"),
      TextPart.make({ text: "Here is one for `greet.ts`." }),
    ],
  },
]

it("reads the whole Agent review in a side panel without leaving Overview, until it is closed", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  const card = await screen.findByRole("region", { name: "Agent review" })
  await f.user.click(within(card).getByRole("button", { name: "Read the full review" }))

  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true")
  const panel = await screen.findByRole("complementary", { name: "Agent review" })
  expect(within(panel).getByText("Callers expect the old letter")).toBeDefined()

  await f.user.click(within(panel).getByRole("button", { name: "Close the Agent review" }))
  expect(sidePanel()).toBeNull()
})

it("opens and closes the Agent review with Mod+D, even from its composer", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewThreadTurns: followUps,
  })

  await screen.findByRole("region", { name: "Agent review" })
  await f.user.keyboard("{Control>}d{/Control}")
  expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true")
  expect(sidePanel()).not.toBeNull()

  await f.user.click(await screen.findByRole("textbox", { name: "Follow up" }))
  await f.user.keyboard("{Meta>}d{/Meta}")
  expect(sidePanel()).toBeNull()
})

it("keeps the Tour order and place while reading the Agent review", async () => {
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

  await openTourOrder(f.user)
  const tourOrder = screen.getByRole("button", { name: "Tour" })
  expect(tourOrder.getAttribute("aria-pressed")).toBe("true")
  const chapters = screen.getByLabelText("Tour Chapters")
  await new Promise(requestAnimationFrame)
  chapters.scrollTop = 500

  await f.user.click(screen.getByRole("button", { name: "Agent work" }))
  await f.user.click(
    within(await screen.findByRole("listitem", { name: "Agent review" })).getByRole("button", {
      name: "Read",
    }),
  )
  await new Promise(requestAnimationFrame)
  expect(sidePanel()).not.toBeNull()
  expect(tourOrder.getAttribute("aria-pressed")).toBe("true")
  expect(chapters.scrollTop).toBe(500)
})

it("marks an outdated Agent review and still reads it", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: {
      review: reviewOf(new Revision({ base: "b0", head: "0123456789abcdef" })),
      job: { status: "idle" },
    },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))

  await f.user.click(screen.getByRole("button", { name: "Agent work" }))
  const row = within(await screen.findByRole("listitem", { name: "Agent review" }))

  expect((await row.findByText(/Written for head/)).textContent).toBe("Written for head 0123456")
  await f.user.click(row.getByRole("button", { name: "Read" }))
  expect(sidePanel()).not.toBeNull()
})

const readFullReview = async (f: ReturnType<typeof mountTourWorkspace>) => {
  const card = await screen.findByRole("region", { name: "Agent review" })
  await f.user.click(within(card).getByRole("button", { name: "Read the full review" }))
}

it("takes no Follow-ups on an Agent review with no Thread", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  await readFullReview(f)

  expect(
    await screen.findByText("This Agent review takes no Follow-ups. Review again to follow up."),
  ).toBeDefined()
  expect(screen.queryByRole("textbox", { name: "Follow up" })).toBeNull()
})

it("leaves out the Turn that wrote the Agent review, showing only its Follow-ups", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewThreadTurns: [reviewTurn, ...followUps],
  })

  await readFullReview(f)

  expect(await screen.findByText("Draft a comment for the letter change.")).toBeDefined()
  expect(screen.queryByText(/PR material/)).toBeNull()
  expect(screen.queryByText("Handed in.")).toBeNull()
})

const draftPrComments =
  "Draft PR comments without using jargon and speak coherently. State it more simply and concisely, like one human talking to another."

it("sends Follow-ups and suggestions to the review's Thread", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewThreadTurns: followUps,
  })

  await readFullReview(f)
  await f.user.type(
    await screen.findByRole("textbox", { name: "Follow up" }),
    "And the other caller?{Enter}",
  )

  await waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce())
  expect(f.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    threadId: "review-agent",
    message: "And the other caller?",
  })

  await f.user.click(await screen.findByRole("button", { name: "Draft PR comments" }))

  await waitFor(() => expect(f.sendMessage).toHaveBeenCalledTimes(2))
  expect(f.sendMessage.mock.calls[1]?.[0]).toMatchObject({
    threadId: "review-agent",
    message: draftPrComments,
  })
})

it("adds a suggested Draft as the user edited it", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewThreadTurns: followUps,
  })

  await readFullReview(f)

  const suggested = await screen.findByRole("region", {
    name: "Suggested draft on greet.ts line +2",
  })

  expect(screen.getAllByRole("region", { name: /^Suggested draft/ })).toHaveLength(1)
  expect(screen.getByText("suggest_draft")).toBeDefined()
  await f.user.click(within(suggested).getByRole("button", { name: "Edit" }))
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
    reviewThreadTurns: followUps,
  })

  await readFullReview(f)

  expect(await screen.findByText(/Here is one for/)).toBeDefined()
  expect(
    screen.getByText("Written for an older Revision. Review again to follow up."),
  ).toBeDefined()
  expect(screen.queryByRole("textbox", { name: "Follow up" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Add Draft" })).toBeNull()
})

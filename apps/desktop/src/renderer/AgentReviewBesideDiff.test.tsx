// @vitest-environment happy-dom
import {
  AgentReviewFailure,
  Revision,
  SUGGEST_DRAFT_TOOL,
  type SuggestedDraft,
  TextPart,
  ToolCallPart,
  type Turn,
  TurnDone,
} from "@glass/contracts"
import { act, screen, waitFor, within } from "@testing-library/react"
import { DateTime, Deferred, Effect } from "effect"
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
  agentId: "review-agent",
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

const followUps: ReadonlyArray<Turn> = [
  {
    id: "turn-1",
    message: "Draft a comment for the letter change.",
    images: [],
    sentAt,
    ended: { at: sentAt, ending: TurnDone.make({}) },
    parts: [
      suggestion({ path: "greet.ts", side: "new", line: 9, body: "Off the diff." }, "failed"),
      suggestion({ path: "greet.ts", side: "new", line: 2, body: "Callers match on `b`." }, "done"),
      TextPart.make({ text: "Here is one for `greet.ts`." }),
    ],
  },
]

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
  expect(screen.getByRole("textbox", { name: "Follow up" }).textContent).toBe("")
})

it("keeps a refused follow-up in the composer and says why", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: reviewOf(revision), job: { status: "idle" } },
  })

  f.followUp.mockImplementation(() =>
    Effect.fail(
      new AgentReviewFailure({
        reason: "not-ready",
        message: "Wait for the answer to your last Follow-up.",
        runner: null,
      }),
    ),
  )

  await readBesideTheDiff(f)
  const composer = screen.getByRole("textbox", { name: "Follow up" })
  await f.user.type(composer, "Is this blocking?{Enter}")

  expect(await screen.findByText(/Wait for the answer to your last Follow-up/)).toBeDefined()
  expect(composer.textContent).toBe("Is this blocking?")
})

for (const accepted of [true, false])
  it(`keeps a pending message and prevents another send until it is ${accepted ? "accepted" : "refused"}`, async () => {
    const f = mountTourWorkspace({
      files,
      agentReview: { review: reviewOf(revision), job: { status: "idle" } },
    })

    const reply = Deferred.makeUnsafe<void, AgentReviewFailure>()
    f.followUp.mockImplementation(() => Deferred.await(reply))

    await readBesideTheDiff(f)
    const composer = screen.getByRole("textbox", { name: "Follow up" })
    await f.user.type(composer, "Is this blocking?{Enter}")

    expect(composer.textContent).toBe("Is this blocking?")
    expect(composer.getAttribute("aria-readonly")).toBe("true")
    const send = screen.getByRole<HTMLButtonElement>("button", { name: "Send" })
    expect(send.disabled).toBe(true)
    await f.user.click(send)
    await f.user.keyboard("{Enter}")
    expect(f.followUp).toHaveBeenCalledOnce()

    await act(async () => {
      await Effect.runPromise(
        accepted
          ? Deferred.succeed(reply, undefined)
          : Deferred.fail(
              reply,
              new AgentReviewFailure({ reason: "not-ready", message: "Try again.", runner: null }),
            ),
      )
    })

    await waitFor(() => {
      expect(composer.getAttribute("aria-readonly")).toBe("false")
      expect(composer.textContent).toBe(accepted ? "" : "Is this blocking?")
    })

    expect(screen.queryByText(/Try again/) !== null).toBe(!accepted)
    await f.user.click(composer)
    await f.user.keyboard("{Control>}a{/Control}{Backspace}")
    await f.user.type(composer, "A second message{Enter}")
    await waitFor(() => expect(f.followUp).toHaveBeenCalledTimes(2))
  })

it("prevents Retry and Send from overlapping while a retry is being accepted", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: {
      review: reviewOf(revision),
      job: {
        status: "agent-start-failed",
        message: "Why?",
        reason: new AgentReviewFailure({ reason: "runner", message: "Try again.", runner: null }),
      },
    },
  })

  const reply = Deferred.makeUnsafe<void>()
  f.followUp.mockImplementation(() => Deferred.await(reply))
  await readBesideTheDiff(f)
  await f.user.click(screen.getByRole("button", { name: "Retry" }))

  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull()
  await f.user.type(screen.getByRole("textbox", { name: "Follow up" }), "Meanwhile{Enter}")
  expect(f.followUp).toHaveBeenCalledOnce()

  await act(async () => {
    await Effect.runPromise(Deferred.succeed(reply, undefined))
  })
})

it("sends later Follow-ups to the review's Agent", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewAgentTurns: followUps,
  })

  await readBesideTheDiff(f)
  await f.user.type(
    await screen.findByRole("textbox", { name: "Follow up" }),
    "And the other caller?{Enter}",
  )

  await waitFor(() => expect(f.sendMessage).toHaveBeenCalledOnce())
  expect(f.sendMessage.mock.calls[0]?.[0]).toMatchObject({
    agentId: "review-agent",
    message: "And the other caller?",
  })
  expect(f.followUp).not.toHaveBeenCalled()
})

it("adds a suggested Draft as the user edited it", async () => {
  const f = mountTourWorkspace({
    files,
    agentReview: { review: followedUp(revision), job: { status: "idle" } },
    reviewAgentTurns: followUps,
  })

  await readBesideTheDiff(f)

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
    reviewAgentTurns: followUps,
  })

  await readBesideTheDiff(f)

  expect(await screen.findByText(/Here is one for/)).toBeDefined()
  expect(
    screen.getByText("Written for an older Revision. Review again to follow up."),
  ).toBeDefined()
  expect(screen.queryByRole("textbox", { name: "Follow up" })).toBeNull()
  expect(screen.queryByRole("button", { name: "Add Draft" })).toBeNull()
})

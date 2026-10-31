// @vitest-environment happy-dom
import { TourFailure, type TourState } from "@glass/contracts"
import { act, screen, waitFor, within } from "@testing-library/react"
import { DateTime, Deferred, Effect } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { mountTourWorkspace, resetTourWorkspace } from "../../test/tourWorkspace"
import { pullRequestRef, revision } from "../../test/workspace"

afterEach(resetTourWorkspace)

const mount = (initial: TourState = { tour: null, job: { status: "idle" } }) =>
  mountTourWorkspace({ initial })

const commandFailure = (message: string) =>
  new TourFailure({ reason: "storage", runner: null, message })

it("writes only on request", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  expect(f.write).not.toHaveBeenCalled()
  await f.user.click(await screen.findByRole("button", { name: "Write Tour" }))
  expect(f.write).toHaveBeenCalledWith({ pullRequest: pullRequestRef, revision }, expect.anything())
  expect(await screen.findByText("Checking agent…")).toBeDefined()
  await f.publish({
    tour: null,
    job: {
      status: "writing",
      startedAt: f.startedAt,
      runner: { engine: "pi-cli", model: "openai/gpt-test" },
    },
  })
  expect(await screen.findByText("Writing Tour…")).toBeDefined()
  expect(screen.getByText("openai/gpt-test")).toBeDefined()
  expect(screen.getByLabelText("Time elapsed").textContent).toMatch(/^[3-5]s$/)
  await f.user.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(f.cancel).toHaveBeenCalled())
  expect(await screen.findByRole("button", { name: "Write Tour" })).toBeDefined()
})

it("writes a waiting Tour now", async () => {
  const f = mount({ tour: null, job: { status: "waiting" } })
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  expect(await screen.findByText("Waiting to write…")).toBeDefined()
  await f.user.click(screen.getByRole("button", { name: "Write now" }))
  expect(f.write).toHaveBeenCalledWith({ pullRequest: pullRequestRef, revision }, expect.anything())
  expect(await screen.findByText("Checking agent…")).toBeDefined()
})

it("explains a runner failure and retries from the same sidebar", async () => {
  const f = mount({
    tour: null,
    job: {
      status: "failed",
      reason: new TourFailure({
        reason: "not-ready",
        runner: null,
        message: "Claude Code's login could not be verified. Run claude auth login.",
      }),
    },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  expect(await screen.findByRole("alert")).toBeDefined()
  expect(
    screen.getByText("Claude Code's login could not be verified. Run claude auth login."),
  ).toBeDefined()
  await f.user.click(screen.getByRole("button", { name: "Try again" }))
  expect(await screen.findByText("Checking agent…")).toBeDefined()
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.write).toHaveBeenCalledWith({ pullRequest: pullRequestRef, revision }, expect.anything())
  await f.publish({
    tour: null,
    job: {
      status: "failed",
      reason: new TourFailure({
        reason: "not-ready",
        runner: null,
        message: "Claude Code is not signed in.",
      }),
    },
  })
  await f.user.click(screen.getByRole("button", { name: "Try again" }))
  expect(f.write).toHaveBeenCalledTimes(2)
})

it("retries the failed command even when the job changes state", async () => {
  const f = mount()

  const failure = new TourFailure({
    reason: "storage",
    runner: null,
    message: "Couldn't save your Tour. Try again.",
  })

  f.write.mockImplementationOnce(() => Effect.fail(failure))
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  await f.user.click(await screen.findByRole("button", { name: "Write Tour" }))
  await screen.findByRole("alert")
  await f.publish({ tour: null, job: { status: "writing", startedAt: f.startedAt, runner: null } })
  await f.user.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(f.write).toHaveBeenCalledTimes(2))
  expect(f.cancel).not.toHaveBeenCalled()
  f.cancel.mockImplementationOnce(() => Effect.fail(failure))
  await f.user.click(screen.getByRole("button", { name: "Cancel" }))
  await screen.findByRole("alert")
  await f.publish({ tour: null, job: { status: "idle" } })
  await f.user.click(screen.getByRole("button", { name: "Try again" }))
  await waitFor(() => expect(f.cancel).toHaveBeenCalledTimes(2))
  expect(f.write).toHaveBeenCalledTimes(2)
})

it.each(["write", "cancel"] as const)(
  "replaces a failed %s command when the other action is requested",
  async (first) => {
    const f = mount({ tour: null, job: { status: "waiting" } })
    const second = first === "write" ? "cancel" : "write"
    const labels = { write: "Write now", cancel: "Cancel" }
    const response = Effect.runSync(Deferred.make<void, TourFailure>())

    f[first].mockImplementationOnce(() => Effect.fail(commandFailure("First command failed")))
    f[second].mockImplementationOnce(() => Deferred.await(response))

    await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
    await f.user.click(await screen.findByRole("button", { name: labels[first] }))
    expect(await screen.findByText("First command failed")).toBeDefined()

    await f.user.click(screen.getByRole("button", { name: labels[second] }))
    await waitFor(() => {
      expect(f[second]).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole("alert")).toBeNull()

      for (const name of Object.values(labels))
        expect(screen.getByRole("button", { name }).hasAttribute("disabled")).toBe(true)
    })
    expect(screen.getByText("Waiting to write…")).toBeDefined()

    await act(async () => {
      await Effect.runPromise(Deferred.fail(response, commandFailure("Second command failed")))
    })
    expect(await screen.findByText("Second command failed")).toBeDefined()
    expect(screen.getAllByRole("alert")).toHaveLength(1)
    expect(screen.queryByText("First command failed")).toBeNull()

    await f.user.click(screen.getByRole("button", { name: "Try again" }))
    await waitFor(() => expect(f[second]).toHaveBeenCalledTimes(2))
    expect(f[first]).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("alert")).toBeNull()
  },
)

it("restores the intent and ordered Chapters using safe inline formatting", async () => {
  const f = mount({
    tour: {
      revision,
      writtenAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
      intent: "Fix **names** with `Person`. <img src=x> [link](https://example.com)",
      chapters: [
        {
          title: "Name the greeting",
          explanation: "Behavior changes.",
          files: [{ path: "greet.ts", summary: "Greets a person." }],
        },
        { title: "Document usage", explanation: "Show an example.", files: [] },
      ],
      everythingElse: [],
    },
    job: { status: "idle" },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  const saved = await screen.findByRole("region", { name: "Saved Tour" })
  expect(saved.querySelector("strong")?.textContent).toBe("names")
  expect(saved.querySelector("code")?.textContent).toBe("Person")
  expect(saved.querySelector("img, a")).toBeNull()
  expect(saved.textContent).toContain("<img src=x> [link](https://example.com)")
  expect(Array.from(saved.querySelectorAll("li"), (item) => item.textContent)).toEqual([
    "01Name the greeting",
    "02Document usage",
  ])
  expect(screen.queryByRole("button", { name: "Write Tour" })).toBeNull()
  expect(f.write).not.toHaveBeenCalled()
})

it("receives the saved Tour while reviewing another sidebar tab", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  await f.user.click(await screen.findByRole("button", { name: "Write Tour" }))
  await f.user.click(screen.getByRole("tab", { name: /^Notes/ }))
  await f.publish({
    tour: {
      revision,
      writtenAt: DateTime.makeUnsafe("2026-10-22T00:00:00Z"),
      intent: "Explain the greeting.",
      chapters: [{ title: "Greeting", explanation: "What changed.", files: [] }],
      everythingElse: [],
    },
    job: { status: "idle" },
  })
  await f.user.click(screen.getByRole("tab", { name: "Tour" }))
  const sidebar = await screen.findByRole("region", { name: "Saved Tour" })
  expect(within(sidebar).getByText("Explain the greeting.")).toBeDefined()
  expect(f.write).toHaveBeenCalledTimes(1)
  expect(f.cancel).not.toHaveBeenCalled()
})

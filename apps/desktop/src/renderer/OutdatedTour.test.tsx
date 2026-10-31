// @vitest-environment happy-dom
import { Revision, type Tour, TourFailure, type TourState } from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vite-plus/test"
import {
  chapter,
  changes,
  fileOrder,
  mountTourWorkspace,
  resetTourWorkspace,
} from "../../test/tourWorkspace"
import { changedFile, pullRequestRef, revision, savedTour, tourChapter } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("api.ts"), changedFile("greet.ts"), changedFile("new.ts")]

const older: Tour = {
  ...savedTour([
    tourChapter("Greet by name", ["greet.ts", "gone.ts"]),
    tourChapter("Drop the old helper", ["removed.ts"]),
    tourChapter("Expose the greeting", ["api.ts"]),
  ]),
  revision: new Revision({ base: "b0", head: "0123456789abcdef" }),
}

const idle = (tour: Tour): TourState => ({ tour, job: { status: "idle" } })

const mount = (tour: Tour) => mountTourWorkspace({ files, initial: idle(tour) })

const sidebar = () => screen.getByRole("region", { name: "Saved Tour" })

it("reads an outdated Tour against the files the PR has now", async () => {
  const f = mount(older)
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))

  const banner = await screen.findByRole("note")
  expect(banner.textContent).toContain("Written for an older Revision (head 0123456)")
  expect(within(banner).queryByRole("button")).toBeNull()
  expect(within(sidebar()).getByText("Greet people by name.")).toBeDefined()
  expect(within(sidebar()).getAllByLabelText("0 of 1 files viewed")).toHaveLength(2)
  expect(
    within(within(sidebar()).getByRole("button", { name: /Drop the old helper/ })).queryByLabelText(
      /files viewed/,
    ),
  ).toBeNull()

  await f.user.click(screen.getByRole("tab", { name: "Changes" }))
  await waitFor(() => expect(fileOrder()).toEqual(["greet.ts", "api.ts", "new.ts"]))
  expect(screen.getAllByRole("note")).toHaveLength(1)
  expect(within(changes()).getByRole("note")).toBeDefined()
  expect(within(changes()).getByText("greet.ts summary")).toBeDefined()
  expect(within(changes()).queryByText("gone.ts summary")).toBeNull()
  expect(chapter("Everything else").textContent).toContain("0/1 viewed")

  const dropped = chapter("Drop the old helper")
  expect(dropped.textContent).toContain("Drop the old helper explained.")
  expect(dropped.textContent).not.toContain("viewed")
  expect(
    within(dropped).queryByRole("checkbox", { name: "Chapter viewed: Drop the old helper" }),
  ).toBeNull()

  await f.user.click(
    within(chapter("Greet by name")).getByRole("checkbox", {
      name: "Chapter viewed: Greet by name",
    }),
  )
  await waitFor(() => expect(f.setViewed).toHaveBeenCalledTimes(1))
  expect(f.setViewed).toHaveBeenCalledWith(
    { pullRequestId: "PR_1", revision, path: "greet.ts", viewed: true },
    expect.anything(),
  )
  expect(within(sidebar()).getByLabelText("All files viewed")).toBeDefined()
})

it("treats a Tour as outdated when only its base differs, and current when both match", async () => {
  const f = mount({ ...older, revision: new Revision({ base: "a0", head: revision.head }) })
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  expect((await screen.findByRole("note")).textContent).toContain("(head h1)")

  await f.publish(idle({ ...older, revision }))
  await waitFor(() => expect(screen.queryByRole("note")).toBeNull())
  await f.user.click(within(sidebar()).getByRole("button", { name: "Rewrite" }))
  expect(f.write).toHaveBeenCalledWith({ pullRequest: pullRequestRef, revision }, expect.anything())
})

it("keeps the old Tour readable through a rewrite until its replacement arrives", async () => {
  const f = mount(older)
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  await waitFor(() => expect(fileOrder()).toEqual(["greet.ts", "api.ts", "new.ts"]))
  await f.user.click(screen.getByRole("tab", { name: "Tour" }))
  await f.user.click(within(changes()).getByRole("button", { name: "Rewrite" }))
  expect(f.write).toHaveBeenCalledWith({ pullRequest: pullRequestRef, revision }, expect.anything())
  expect(await screen.findByText("Checking agent…")).toBeDefined()
  expect(screen.queryByRole("button", { name: "Rewrite" })).toBeNull()
  expect(within(sidebar()).getByText("Greet people by name.")).toBeDefined()

  const runner = { engine: "pi-cli" as const, model: "openai/gpt-test" }
  await f.publish({ tour: older, job: { status: "writing", startedAt: f.startedAt, runner } })
  expect(await screen.findByText("openai/gpt-test")).toBeDefined()
  expect(within(sidebar()).getByRole("button", { name: /Greet by name/ })).toBeDefined()
  expect(chapter("Greet by name").textContent).toContain("Greet by name explained.")

  await f.user.click(screen.getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(f.cancel).toHaveBeenCalled())
  expect(await within(sidebar()).findByRole("button", { name: "Rewrite" })).toBeDefined()
  expect(within(sidebar()).getByText("Greet people by name.")).toBeDefined()

  await f.publish({
    tour: older,
    job: {
      status: "failed",
      reason: new TourFailure({
        reason: "authentication",
        runner,
        message: "pi couldn't sign in to openai. Sign in again, then try again.",
      }),
    },
  })
  expect(await screen.findByText(/pi couldn't sign in to openai/)).toBeDefined()
  expect(within(sidebar()).getByText("Greet people by name.")).toBeDefined()
  expect(chapter("Greet by name").textContent).toContain("Greet by name explained.")
  await f.user.click(screen.getByRole("button", { name: "Try again" }))
  expect(f.write).toHaveBeenCalledTimes(2)

  await f.publish(
    idle({
      ...savedTour([tourChapter("Add the welcome", ["new.ts"])], ["greet.ts", "api.ts"]),
      intent: "Welcome newcomers.",
    }),
  )
  expect(await within(sidebar()).findByText("Welcome newcomers.")).toBeDefined()
  expect(screen.queryByRole("note")).toBeNull()
  expect(within(sidebar()).queryByText("Greet by name")).toBeNull()
  await waitFor(() => expect(fileOrder()).toEqual(["new.ts", "greet.ts", "api.ts"]))
  expect(chapter("Add the welcome").textContent).toContain("CHAPTER 01 / 01")
})

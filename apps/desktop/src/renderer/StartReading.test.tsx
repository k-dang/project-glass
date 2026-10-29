// @vitest-environment happy-dom
import { TourFailure } from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { DateTime } from "effect"
import { afterEach, expect, it } from "vite-plus/test"
import { fileOrder, mountTourWorkspace, resetTourWorkspace } from "../../test/tourWorkspace"
import { changedFile, savedTour, tourChapter } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("api.ts"), changedFile("greet.ts"), changedFile("notes.md")]

const tour = savedTour([
  tourChapter("Greet by name", ["greet.ts"]),
  tourChapter("Drop the old helper", ["removed.ts"]),
  tourChapter("Expose the greeting", ["api.ts"]),
])

const mount = () => mountTourWorkspace({ files, initial: { tour, job: { status: "idle" } } })

const expectTourOrder = async () => {
  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
  expect(screen.getByRole("button", { name: "Tour" }).getAttribute("aria-pressed")).toBe("true")
  await waitFor(() => expect(fileOrder()).toEqual(["greet.ts", "api.ts", "notes.md"]))
}

it("offers the Tour at the top of Overview, without announcing one already written", async () => {
  const f = mount()
  const card = await screen.findByRole("region", { name: "Tour" })
  expect(within(card).getByText("Greet people by name.")).toBeDefined()
  expect(within(card).getByText("3 Chapters")).toBeDefined()
  expect(screen.queryByText("Tour ready")).toBeNull()

  await f.user.click(within(card).getByRole("button", { name: "Start reading" }))
  await expectTourOrder()
})

it("announces a Tour that finishes writing, but not a cancelled or failed one", async () => {
  const older = savedTour([tourChapter("Greet by name", ["greet.ts"])])
  const writing = { status: "writing" as const, startedAt: Date.now(), runner: null }
  const f = mountTourWorkspace({ files, initial: { tour: older, job: writing } })
  await screen.findByRole("region", { name: "Tour" })

  await f.publish({ tour: older, job: { status: "idle" } })
  expect(screen.queryByText("Tour ready")).toBeNull()

  await f.publish({ tour: older, job: writing })
  await f.publish({
    tour: older,
    job: {
      status: "failed",
      reason: new TourFailure({ reason: "runner", runner: null, message: "The runner quit." }),
    },
  })
  expect(screen.queryByText("Tour ready")).toBeNull()

  await f.publish({ tour: older, job: writing })

  await f.publish({
    tour: { ...tour, writtenAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z") },
    job: { status: "idle" },
  })
  const toast = (await screen.findByText("Tour ready")).closest<HTMLElement>("[data-slot=toast]")!
  expect(toast.textContent).toContain("3 Chapters")

  await f.user.click(within(toast).getByRole("button", { name: "Start reading" }))
  await expectTourOrder()
})

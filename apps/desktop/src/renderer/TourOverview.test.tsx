// @vitest-environment happy-dom
import type { Tour } from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { changes, mountTourWorkspace, resetTourWorkspace } from "../../test/tourWorkspace"
import { changedFile, savedTour, tourChapter } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("api.ts"), changedFile("greet.ts")]

const beforeAfter = {
  title: "How a greeting is built",
  lines: [
    { depth: 0, text: "build the greeting", change: "unchanged", target: null },
    {
      depth: 1,
      text: "use the name",
      change: "added",
      target: { path: "greet.ts", side: "new", startLine: 1, endLine: 1 },
    },
  ],
} as const

const chapters = [tourChapter("Greet by name", ["greet.ts"]), tourChapter("Expose it", ["api.ts"])]

const mount = (tour: Tour = { ...savedTour(chapters), beforeAfter }) =>
  mountTourWorkspace({ files, initial: { tour, job: { status: "idle" } } })

const startReading = async (f: ReturnType<typeof mount>) => {
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  await f.user.click(
    within(await screen.findByRole("region", { name: "Saved Tour" })).getByRole("button", {
      name: "Start reading",
    }),
  )
}

it("opens on the Tour overview, with the Before / after above the first Chapter", async () => {
  const scrollTo = vi.spyOn(Element.prototype, "scrollTo")
  const f = mount()
  await startReading(f)

  const overview = await screen.findByRole("region", { name: "Tour overview" })
  expect(within(overview).getByText("Greet people by name.")).toBeDefined()
  expect(within(overview).getByText("2 Chapters · 2 files")).toBeDefined()

  const shown = within(overview).getByRole("region", {
    name: "Before / after: How a greeting is built",
  })

  expect(within(shown).getByRole("button", { name: /use the name/ })).toBeDefined()
  expect(within(shown).queryByRole("button", { name: /build the greeting/ })).toBeNull()
  expect(within(shown).getByText("build the greeting")).toBeDefined()
  await waitFor(() => expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, behavior: "instant" }))
})

it("reopens a viewed Chapter when the Before / after points into it", async () => {
  const f = mount()
  await startReading(f)
  const overview = await screen.findByRole("region", { name: "Tour overview" })
  const chapter = screen.getByRole("region", { name: "Greet by name" })

  await f.user.click(
    within(chapter).getByRole("checkbox", { name: "Chapter viewed: Greet by name" }),
  )
  await within(changes()).findByRole("button", { name: /Greet by name/ })

  await f.user.click(within(overview).getByRole("button", { name: /use the name/ }))

  expect(
    await screen.findByRole("checkbox", { name: "Chapter viewed: Greet by name" }),
  ).toBeDefined()
})

it("has no Tour overview without a Before / after", async () => {
  const f = mount(savedTour(chapters))
  await startReading(f)

  await screen.findByRole("region", { name: "Greet by name" })
  expect(screen.queryByRole("region", { name: "Tour overview" })).toBeNull()
})

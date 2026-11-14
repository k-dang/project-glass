// @vitest-environment happy-dom
import { Tour } from "@glass/contracts"
import { DateTime, Schema } from "effect"
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

it("opens a diagram-only overview and follows nodes across Chapters, reopening viewed code", async () => {
  const f = mount({
    ...savedTour(chapters),
    diagram: {
      nodes: [
        {
          id: "greet",
          label: "Greet by name",
          change: "added",
          target: { path: "greet.ts", side: "new", startLine: 2, endLine: 2 },
        },
        {
          id: "api",
          label: "Expose the greeting",
          change: "unchanged",
          target: { path: "api.ts", side: "old", startLine: 2, endLine: 2 },
        },
      ],
      edges: [{ from: "greet", to: "api", change: "added", label: "return greeting" }],
    },
  })

  await startReading(f)
  const overview = await screen.findByRole("region", { name: "Tour overview" })
  const diagram = within(overview).getByRole("figure", { name: "Change diagram for Tour overview" })
  expect(within(diagram).getByText(/Chapter 02/)).toBeDefined()
  expect(within(diagram).getByText("+ return greeting")).toBeDefined()
  const chapter = screen.getByRole("region", { name: "Expose it" })
  await f.user.click(within(chapter).getByRole("checkbox", { name: "Chapter viewed: Expose it" }))
  await within(chapter).findByRole("button", { name: /Expose it/ })
  await f.user.click(within(diagram).getByRole("button", { name: /^Expose the greeting,/ }))
  expect(await screen.findByRole("checkbox", { name: "Chapter viewed: Expose it" })).toBeDefined()
  expect(f.setViewed).toHaveBeenCalledTimes(1)
})

it("keeps diagram selection and playback through job updates, and resets them for a new Tour", async () => {
  const tour: Tour = {
    ...savedTour(chapters),
    diagram: {
      nodes: [
        {
          id: "greet",
          label: "Build greeting",
          change: "added",
          target: { path: "greet.ts", side: "new", startLine: 2, endLine: 2 },
        },
        {
          id: "api",
          label: "Return greeting",
          change: "unchanged",
          target: { path: "api.ts", side: "new", startLine: 2, endLine: 2 },
        },
      ],
      edges: [{ from: "greet", to: "api", change: "added" }],
      steps: [
        { caption: "Build the named greeting.", nodes: ["greet"], edges: [], stateChanges: [] },
        { caption: "Return it through the API.", nodes: ["api"], edges: [0], stateChanges: [] },
      ],
    },
  }

  const freshTour = () => Schema.decodeUnknownSync(Tour)(Schema.encodeSync(Tour)(tour))
  const f = mount(tour)
  await startReading(f)
  const changePanel = within(changes())
  const overview = () => within(changePanel.getByRole("region", { name: /^Tour overview$/ }))
  const flow = () => within(overview().getByRole("group", { name: "Flow steps" }))
  const returned = () => overview().getByRole("button", { name: /^Return greeting,/ })

  await f.user.click(flow().getByRole("button", { name: "Next flow step" }))
  await f.user.click(flow().getByRole("button", { name: "Next flow step" }))
  expect(flow().getByText("2 / 2")).toBeDefined()
  expect(returned().getAttribute("aria-pressed")).toBe("true")

  await f.publish({
    tour: freshTour(),
    job: { status: "writing", startedAt: f.startedAt, runner: null },
  })
  expect(flow().getByText("2 / 2")).toBeDefined()
  expect(returned().getAttribute("aria-pressed")).toBe("true")

  await f.publish({ tour: freshTour(), job: { status: "idle" } })
  expect(flow().getByText("2 / 2")).toBeDefined()
  expect(returned().getAttribute("aria-pressed")).toBe("true")

  await f.publish({
    tour: { ...freshTour(), writtenAt: DateTime.makeUnsafe("2026-10-23T00:00:00Z") },
    job: { status: "idle" },
  })
  expect(flow().getByText("Overview")).toBeDefined()
  expect(returned().getAttribute("aria-pressed")).toBe("false")
  expect(flow().getByRole("button", { name: "Previous flow step" }).hasAttribute("disabled")).toBe(
    true,
  )
})

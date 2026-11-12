// @vitest-environment happy-dom
import { type AgentReview, type Hotspot, Revision } from "@glass/contracts"
import { screen, within } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { reviewOf } from "../../test/agentReview"
import { mountTourWorkspace, resetTourWorkspace } from "../../test/tourWorkspace"
import { changedFile, revision, savedTour, tourChapter } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [changedFile("api.ts"), changedFile("greet.ts"), changedFile("CHANGELOG.md")]

const hotspot = (title: string, place: Hotspot["place"]): Hotspot => ({
  title,
  kind: "public-contract",
  place,
  why: `${title} matters.`,
  evidence: "greet(name)",
  check: `Check ${title}.`,
})

const reviewWithHotspots = (reviewed: Revision): AgentReview => ({
  ...reviewOf(reviewed),
  hotspots: [
    hotspot("Callers pass no name", { path: "greet.ts", side: "new", startLine: 2, endLine: 2 }),
    hotspot("The greeting leaves the API", null),
  ],
  lowAttention: [{ path: "CHANGELOG.md", reason: "Release note" }],
})

const tour = savedTour([
  tourChapter("Greet by name", ["greet.ts"]),
  tourChapter("Expose it", ["api.ts"]),
  tourChapter("Release it", ["CHANGELOG.md"]),
])

const mount = (reviewed = revision) =>
  mountTourWorkspace({
    files,
    initial: { tour, job: { status: "idle" } },
    agentReview: { review: reviewWithHotspots(reviewed), job: { status: "idle" } },
  })

const sidePanel = () => screen.getByRole("complementary", { name: "Agent review" })

const startReading = async (f: ReturnType<typeof mount>) =>
  f.user.click(
    within(await screen.findByRole("region", { name: "Tour" })).getByRole("button", {
      name: "Start reading",
    }),
  )

it("ranks the Agent review's hotspots and links a placed one to its Tour Chapter", async () => {
  const scrolled = vi.spyOn(Element.prototype, "scrollIntoView")
  const f = mount()
  const card = await screen.findByRole("region", { name: "Agent review" })

  await f.user.click(
    within(within(card).getByRole("list", { name: "Hotspots" })).getByRole("button", {
      name: /The greeting leaves the API/,
    }),
  )

  const points = within(within(sidePanel()).getByRole("list", { name: "Hotspots" })).getAllByRole(
    "listitem",
  )

  expect(within(points[0]!).getByRole("heading", { name: /Callers pass no name/ })).toBeDefined()
  expect(
    within(points[1]!).getByRole("heading", { name: /The greeting leaves the API/ }),
  ).toBeDefined()
  expect(scrolled.mock.contexts).toEqual([points[1]])
  expect(within(points[1]!).queryByRole("button", { name: /Tour Chapter/ })).toBeNull()

  await f.user.click(within(points[0]!).getByRole("button", { name: "Tour Chapter 01" }))
  expect(screen.getByRole("button", { name: "Tour" }).getAttribute("aria-pressed")).toBe("true")
})

it("opens the Tour on where to look first, and reads a Chapter's hotspot in the Agent review", async () => {
  const f = mount()
  await startReading(f)

  const first = await screen.findByRole("navigation", { name: "Where to look first" })
  const [placed, unplaced] = within(first).getAllByRole("listitem")
  expect(within(placed!).getByText("Callers pass no name")).toBeDefined()
  expect(within(placed!).getByText("Chapter 01")).toBeDefined()
  expect(within(unplaced!).getByText("The greeting leaves the API")).toBeDefined()
  expect(within(unplaced!).queryByText(/Chapter/)).toBeNull()

  const greet = screen.getByRole("region", { name: "Greet by name" })
  expect(within(greet).getByText("1 hotspot")).toBeDefined()
  const release = screen.getByRole("region", { name: "Release it" })
  expect(within(release).getAllByText("Low attention")).toHaveLength(2)

  const hotspots = within(greet).getByRole("navigation", { name: "Hotspots in Greet by name" })
  await f.user.click(within(hotspots).getByRole("button", { name: /Read in the Agent review/ }))
  expect(within(sidePanel()).getByText("Callers pass no name")).toBeDefined()
})

it("leaves hotspots out of a Tour of another Revision than the Agent review's", async () => {
  const f = mount(new Revision({ base: "b0", head: "0123456789abcdef" }))
  await startReading(f)

  await screen.findByRole("region", { name: "Greet by name" })
  expect(screen.queryByRole("navigation", { name: "Where to look first" })).toBeNull()
  expect(screen.queryByText("1 hotspot")).toBeNull()
})

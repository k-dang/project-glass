// @vitest-environment happy-dom
import { BinaryFile, type Tour } from "@glass/contracts"
import { screen, waitFor, within } from "@testing-library/react"
import { afterEach, expect, it } from "vite-plus/test"
import {
  chapter,
  changes,
  fileOrder,
  mountTourWorkspace,
  resetTourWorkspace,
} from "../../test/tourWorkspace"
import { changedFile, revision, savedTour } from "../../test/workspace"

afterEach(resetTourWorkspace)

const files = [
  changedFile("api.ts"),
  changedFile("greet.ts"),
  changedFile("greet.test.ts"),
  changedFile("logo.png", BinaryFile.make({})),
  changedFile("notes.md"),
]

const tour = savedTour([
  {
    title: "Greet by name",
    explanation: "The greeting now takes a `name`.",
    files: [
      { path: "greet.ts", summary: "Builds the greeting from a name." },
      { path: "greet.test.ts", summary: "Covers the named greeting." },
    ],
  },
  {
    title: "Expose the greeting",
    explanation: "The API passes the name through.",
    files: [
      { path: "api.ts", summary: "Forwards the name." },
      { path: "logo.png", summary: "Shows the new logo." },
    ],
  },
])

const all = ["greet.ts", "greet.test.ts", "api.ts", "logo.png", "notes.md"]

/** Each file's chevron: "Show" while collapsed, "Hide" while open. */
const toggles = (...paths: Array<string>) =>
  paths.map((path) =>
    within(changes())
      .getByRole("button", { name: (name) => name === `Show ${path}` || name === `Hide ${path}` })
      .getAttribute("aria-label"),
  )

const mount = (saved: Tour | null = tour) =>
  mountTourWorkspace({ files, initial: { tour: saved, job: { status: "idle" } } })

it("opens Changes in Tour order, with Chapter explanations beside continuous diffs", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))

  await waitFor(() => expect(fileOrder()).toEqual(all))
  expect(screen.getByRole("button", { name: "Tour" }).getAttribute("aria-pressed")).toBe("true")

  const first = chapter("Greet by name")
  expect(first.textContent).toContain("CHAPTER 01 / 02")
  expect(first.querySelector("code")?.textContent).toBe("name")
  expect(chapter("Expose the greeting").textContent).toContain("CHAPTER 02 / 02")
  expect(chapter("Everything else")).toBeDefined()
  expect(within(changes()).getByText("Builds the greeting from a name.")).toBeDefined()
  expect(within(changes()).getByText("Shows the new logo.")).toBeDefined()
})

it("marks the clicked Chapter file as current", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  const first = await waitFor(() => chapter("Greet by name"))

  const link = within(
    within(first).getByRole("navigation", { name: "Files in Greet by name" }),
  ).getByRole("button", { name: /greet.test.ts/ })

  await f.user.click(link)
  expect(link.getAttribute("aria-current")).toBe("location")
})

it("remembers Path order across workspace tabs", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  await f.user.click(await screen.findByRole("button", { name: "Path" }))

  await waitFor(() =>
    expect(fileOrder()).toEqual(["api.ts", "greet.test.ts", "greet.ts", "logo.png", "notes.md"]),
  )
  expect(within(changes()).queryByRole("region", { name: "Greet by name" })).toBeNull()
  expect(within(changes()).queryByText("Builds the greeting from a name.")).toBeNull()

  await f.user.click(screen.getByRole("tab", { name: "Overview" }))
  await f.user.click(screen.getByRole("tab", { name: "Changes" }))
  await waitFor(() => expect(fileOrder()[0]).toBe("api.ts"))
  expect(screen.getByRole("button", { name: "Path" }).getAttribute("aria-pressed")).toBe("true")
})

it("hides the order toggle without a Tour", async () => {
  const f = mount(null)
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  await waitFor(() => expect(fileOrder()[0]).toBe("api.ts"))
  expect(screen.queryByRole("group", { name: "File order" })).toBeNull()
})

it("saves Chapter and file progress", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Tour" }))
  const sidebar = screen.getByRole("region", { name: "Saved Tour" })
  expect(within(sidebar).getAllByLabelText("0 of 2 files viewed")).toHaveLength(2)

  await f.user.click(screen.getByRole("tab", { name: "Changes" }))

  const mark = await waitFor(() =>
    within(chapter("Greet by name")).getByRole("checkbox", {
      name: "Chapter viewed: Greet by name",
    }),
  )

  await f.user.click(mark)
  await waitFor(() => expect(f.setViewed).toHaveBeenCalledTimes(2))
  expect(f.setViewed.mock.calls.map(([payload]) => payload)).toEqual([
    { pullRequestId: "PR_1", revision, path: "greet.ts", viewed: true },
    { pullRequestId: "PR_1", revision, path: "greet.test.ts", viewed: true },
  ])
  expect(within(sidebar).getByLabelText("All files viewed")).toBeDefined()

  await f.user.click(within(chapter("Greet by name")).getByRole("button", { expanded: false }))
  expect(chapter("Greet by name").textContent).toContain("2/2 viewed")

  await f.user.click(within(changes()).getByRole("checkbox", { name: "Viewed: greet.ts" }))
  await waitFor(() => expect(f.setViewed).toHaveBeenCalledTimes(3))
  expect(f.setViewed.mock.calls[2]![0]).toMatchObject({ path: "greet.ts", viewed: false })
  expect(chapter("Greet by name").textContent).toContain("1/2 viewed")

  await f.user.click(within(changes()).getByRole("checkbox", { name: "Viewed: api.ts" }))
  expect(chapter("Expose the greeting").textContent).toContain("1/2 viewed")
  expect(within(sidebar).getAllByLabelText("1 of 2 files viewed")).toHaveLength(2)
})

it("collapses a saved viewed Chapter to one row until reopened", async () => {
  const f = mountTourWorkspace({
    files,
    viewedPaths: ["greet.ts", "greet.test.ts"],
    initial: { tour, job: { status: "idle" } },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))

  const row = await waitFor(() =>
    within(chapter("Greet by name")).getByRole("button", { expanded: false }),
  )

  expect(row.textContent).toContain("The greeting now takes a name.")
  expect(row.textContent).toContain("2 files")
  expect(fileOrder()).toEqual(["api.ts", "logo.png", "notes.md"])

  await f.user.click(row)
  expect(chapter("Greet by name").textContent).toContain("2/2 viewed")
  expect(fileOrder()).toEqual(all)

  await f.user.click(
    within(chapter("Greet by name")).getByRole("button", {
      name: "Collapse Chapter: Greet by name",
    }),
  )
  expect(within(chapter("Greet by name")).getByRole("button", { expanded: false })).toBeDefined()
})

it("opens a collapsed Chapter to show a file chosen in the Tree", async () => {
  const f = mountTourWorkspace({
    files,
    viewedPaths: ["greet.ts", "greet.test.ts"],
    initial: { tour, job: { status: "idle" } },
  })

  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  await waitFor(() => expect(fileOrder()).toEqual(["api.ts", "logo.png", "notes.md"]))

  const tree = await waitFor(() => {
    const element = document
      .querySelector("file-tree-container")
      ?.shadowRoot?.querySelector<HTMLElement>('[role="tree"]')

    if (element == null) throw new Error("Changed files tree hasn't rendered")

    return element
  })

  await f.user.click(await within(tree).findByRole("treeitem", { name: /greet.test.ts/ }))
  await waitFor(() => expect(fileOrder()).toEqual(all))
})

it.each([
  ["in Tour order", tour],
  ["without a Tour", null],
])("folds a file when marked Viewed and unfolds it when unmarked %s", async (_, saved) => {
  const f = mount(saved)
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  const viewed = await within(changes()).findByRole("checkbox", { name: "Viewed: api.ts" })

  await f.user.click(viewed)
  expect(toggles("api.ts")).toEqual(["Show api.ts"])

  await f.user.click(viewed)
  expect(toggles("api.ts")).toEqual(["Hide api.ts"])
})

it("opens a Chapter from the sidebar in Tour order", async () => {
  const f = mount()
  await f.user.click(await screen.findByRole("tab", { name: "Changes" }))
  await f.user.click(await screen.findByRole("button", { name: "Path" }))
  await f.user.click(screen.getByRole("tab", { name: "Overview" }))
  await f.user.click(screen.getByRole("tab", { name: "Tour" }))
  await f.user.click(await screen.findByRole("button", { name: /Expose the greeting/ }))

  expect(screen.getByRole("tab", { name: "Changes" }).getAttribute("aria-selected")).toBe("true")
  expect(screen.getByRole("button", { name: "Tour" }).getAttribute("aria-pressed")).toBe("true")
  await waitFor(() => expect(fileOrder()[0]).toBe("greet.ts"))
})

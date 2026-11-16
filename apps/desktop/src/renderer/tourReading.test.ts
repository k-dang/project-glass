import { describe, expect, it } from "vite-plus/test"
import { changedFile, savedTour, tourChapter, revision } from "../../test/workspace"
import { Revision } from "@glass/contracts"
import { layOut } from "./changesView"
import { hasOverview, readTour } from "./tourReading"

const files = layOut(["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => changedFile(path))).files

const paths = (reading: ReturnType<typeof readTour>) => reading.files.map(({ file }) => file.path)

describe("readTour", () => {
  it("keeps visuals with their Chapters, hiding them when outdated and code links when a target file disappears", () => {
    const diagram = "flowchart LR\n  a[A] --> b[B]:::added"
    const a = { path: "a.ts", side: "old", startLine: 2, endLine: 2 } as const
    const b = { path: "b.ts", side: "new", startLine: 2, endLine: 2 } as const

    const beforeAfter = {
      title: "A and B",
      lines: [
        { depth: 0, text: "A", change: "unchanged", target: a },
        { depth: 0, text: "B", change: "added", target: b },
      ],
    } as const

    const callouts = [{ label: "Inspect B", target: b }]

    const tour = {
      ...savedTour([{ ...tourChapter("One", ["a.ts", "b.ts"]), diagram, beforeAfter, callouts }]),
      diagram,
    }

    expect(readTour(files, tour, revision, null).diagram).toEqual(diagram)

    const outdatedReading = readTour(
      files,
      tour,
      new Revision({ base: revision.base, head: "new-head" }),
      null,
    )

    expect(outdatedReading.diagram).toBeNull()
    expect(hasOverview(outdatedReading)).toBe(false)
    expect(
      readTour(
        files.filter(({ file }) => file.path !== "b.ts"),
        tour,
        revision,
        null,
      ).diagram,
    ).toEqual(diagram)

    const current = readTour(files, tour, revision, null).chapters[0]!
    expect(current.diagram).toEqual(diagram)
    expect(current.beforeAfter).toEqual(beforeAfter)
    expect(current.callouts).toEqual(callouts)

    const outdated = readTour(
      files,
      tour,
      new Revision({ base: revision.base, head: "new-head" }),
      null,
    ).chapters[0]!

    expect(outdated.diagram).toBeNull()
    expect(outdated.beforeAfter).toBeNull()
    expect(outdated.callouts).toEqual([])

    const missing = readTour(
      files.filter(({ file }) => file.path !== "b.ts"),
      tour,
      revision,
      null,
    ).chapters[0]!

    expect(missing.beforeAfter).toBeNull()
    expect(missing.callouts).toEqual([])
    expect(missing.diagram).toEqual(diagram)
  })

  it("shows a Tour's Before / after only for its current Revision, with its files present", () => {
    const beforeAfter = {
      title: "A",
      lines: [
        {
          depth: 0,
          text: "Add A",
          change: "added",
          target: { path: "a.ts", side: "new", startLine: 1, endLine: 1 },
        },
      ],
    } as const

    const tour = { ...savedTour([tourChapter("One", ["b.ts"])]), beforeAfter }

    expect(readTour(files, tour, revision, null).beforeAfter).toEqual(beforeAfter)
    expect(
      readTour(files, tour, new Revision({ base: revision.base, head: "new-head" }), null)
        .beforeAfter,
    ).toBeNull()
    expect(
      readTour(
        files.filter(({ file }) => file.path !== "a.ts"),
        tour,
        revision,
        null,
      ).beforeAfter,
    ).toBeNull()
  })

  it("shows every changed file once: files gone from the PR drop out, repeats stay first", () => {
    const reading = readTour(
      files,
      savedTour([
        tourChapter("One", ["c.ts", "gone.ts", "a.ts"]),
        tourChapter("Two", ["a.ts", "b.ts"]),
      ]),
      revision,
      null,
    )

    expect(reading.chapters.map((each) => each.paths)).toEqual([["c.ts", "a.ts"], ["b.ts"]])
    expect(paths(reading)).toEqual(["c.ts", "a.ts", "b.ts", "d.ts"])
    expect(reading.chapterOf.get("a.ts")).toBe(0)
    expect(reading.summaries.get("a.ts")).toBe("a.ts summary")
  })

  it("puts the Tour's unplaced files in Everything else first, then the rest in path order", () => {
    const reading = readTour(
      files,
      savedTour([tourChapter("One", ["b.ts"])], ["d.ts", "gone.ts"]),
      revision,
      null,
    )

    expect(paths(reading)).toEqual(["b.ts", "d.ts", "a.ts", "c.ts"])
    expect(reading.chapterOf.has("d.ts")).toBe(false)
  })

  it("keeps file-free Chapters in reading order when their files have disappeared", () => {
    const reading = readTour(
      files,
      savedTour([
        tourChapter("One", ["a.ts"]),
        tourChapter("Removed", ["gone.ts"]),
        tourChapter("Two", ["b.ts", "c.ts", "d.ts"]),
      ]),
      revision,
      null,
    )

    expect(
      reading.chapters.map((chapter) => ({ title: chapter.title, paths: chapter.paths })),
    ).toEqual([
      { title: "One", paths: ["a.ts"] },
      { title: "Removed", paths: [] },
      { title: "Two", paths: ["b.ts", "c.ts", "d.ts"] },
    ])
  })
})

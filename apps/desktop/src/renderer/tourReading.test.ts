import { describe, expect, it } from "vite-plus/test"
import { changedFile, savedTour, tourChapter } from "../../test/workspace"
import { layOut } from "./changesView"
import { readTour } from "./tourReading"

const files = layOut(["a.ts", "b.ts", "c.ts", "d.ts"].map((path) => changedFile(path))).files

const paths = (reading: ReturnType<typeof readTour>) => reading.files.map(({ file }) => file.path)

describe("readTour", () => {
  it("shows every changed file once: files gone from the PR drop out, repeats stay first", () => {
    const reading = readTour(
      files,
      savedTour([
        tourChapter("One", ["c.ts", "gone.ts", "a.ts"]),
        tourChapter("Two", ["a.ts", "b.ts"]),
      ]),
    )

    expect(reading.chapters.map((each) => each.paths)).toEqual([["c.ts", "a.ts"], ["b.ts"]])
    expect(paths(reading)).toEqual(["c.ts", "a.ts", "b.ts", "d.ts"])
    expect(reading.chapterOf.get("a.ts")).toBe(0)
    expect(reading.summaries.get("a.ts")).toBe("a.ts summary")
  })

  it("puts the Tour's unplaced files in Everything else first, then the rest in path order", () => {
    const reading = readTour(files, savedTour([tourChapter("One", ["b.ts"])], ["d.ts", "gone.ts"]))

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

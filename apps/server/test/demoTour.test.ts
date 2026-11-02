import { ChangedFile, Chapter, TextPatch } from "@glass/contracts"
import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { repairChapterVisuals } from "../src/tourVisuals"
import { rateLimitFiles } from "./demoPullRequests"
import { demoTour } from "./demoTour"

it("keeps every demo visual valid against the seeded PR's diff", () => {
  const chapters = Schema.decodeUnknownSync(Schema.Array(Chapter))(demoTour.chapters)

  const files = rateLimitFiles.map(
    ({ base, change }) =>
      new ChangedFile({
        path: change.path,
        previousPath: null,
        changeType: base === null ? "added" : "modified",
        additions: change.additions ?? 0,
        deletions: change.deletions ?? 0,
        patch: TextPatch.make({ hunks: change.patch! }),
      }),
  )

  expect(chapters.map((chapter) => repairChapterVisuals(chapter, files))).toEqual(demoTour.chapters)
  expect(chapters.flatMap((chapter) => chapter.files.map(({ path }) => path)).toSorted()).toEqual(
    rateLimitFiles.map(({ path }) => path).toSorted(),
  )
})

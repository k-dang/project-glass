import { Schema } from "effect"
import { expect, it } from "vite-plus/test"
import { TourAnswer } from "../src/tourPrompt"
import { repairChapterVisuals, repairTourVisuals } from "../src/tourVisuals"
import { tourOverviewExamples, tourOverviewFiles } from "./demoTourOverviews"

it.each(tourOverviewExamples)(
  "keeps the hand-authored map anchored to its example diff: $title",
  (example) => {
    const answer = Schema.decodeUnknownSync(TourAnswer)(example.tour)
    const files = tourOverviewFiles(example)
    const visuals = repairTourVisuals(answer, files)

    expect(visuals.diagram).toEqual(answer.diagram ?? null)
    expect(visuals.beforeAfter).toEqual(answer.beforeAfter ?? null)
    expect(answer.chapters.map((chapter) => repairChapterVisuals(chapter, files))).toEqual(
      answer.chapters,
    )
    expect(
      answer.chapters.flatMap((chapter) => chapter.files.map(({ path }) => path)).toSorted(),
    ).toEqual(files.map(({ path }) => path).toSorted())
  },
)

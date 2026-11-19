import type {
  ChangedFile,
  Chapter,
  TourBeforeAfter,
  TourCallouts,
  TourDiagram,
  Tour,
} from "@glass/contracts"
import { rangeInFiles } from "./github/patchLines"
import { drawWithPele } from "./mermaid"

export const validateTourDiagram = (diagram: TourDiagram): TourDiagram | null => {
  const drawn = drawWithPele(diagram)

  return "type" in drawn && drawn.type === "flowchart" ? diagram : null
}

export const validateTourBeforeAfter = (
  beforeAfter: TourBeforeAfter,
  files: ReadonlyArray<ChangedFile>,
): TourBeforeAfter | null => {
  const changed = beforeAfter.lines.filter((line) => line.change !== "unchanged")

  if (changed.length === 0) return null

  if (
    !changed.every(
      ({ change, target }) =>
        target !== null &&
        target.side === (change === "added" ? "new" : "old") &&
        rangeInFiles(files, target),
    )
  )
    return null

  return {
    ...beforeAfter,
    lines: beforeAfter.lines.map((line) =>
      line.target === null || rangeInFiles(files, line.target) ? line : { ...line, target: null },
    ),
  }
}

const validateTourCallouts = (callouts: TourCallouts, files: ReadonlyArray<ChangedFile>) =>
  callouts.filter((callout) => rangeInFiles(files, callout.target))

export const repairTourVisuals = (
  tour: Pick<Tour, "diagram" | "beforeAfter">,
  files: ReadonlyArray<ChangedFile>,
) => {
  const diagram = tour.diagram == null ? null : validateTourDiagram(tour.diagram)

  const beforeAfter =
    diagram !== null || tour.beforeAfter == null
      ? null
      : validateTourBeforeAfter(tour.beforeAfter, files)

  return { diagram, beforeAfter }
}

export const repairChapterVisuals = (
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
): Chapter => {
  const repaired = { ...chapter }
  const inChapter = files.filter((file) => chapter.files.some(({ path }) => path === file.path))

  if (chapter.diagram != null) repaired.diagram = validateTourDiagram(chapter.diagram)

  if (chapter.beforeAfter != null)
    repaired.beforeAfter = validateTourBeforeAfter(chapter.beforeAfter, inChapter)

  if (chapter.callouts != null)
    repaired.callouts = validateTourCallouts(chapter.callouts, inChapter)

  if (repaired.diagram != null && repaired.beforeAfter != null) repaired.beforeAfter = null

  return repaired
}

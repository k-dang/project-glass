import type { Tour, TourDiagram, TourCallTree, TourCallouts, Revision } from "@glass/contracts"
import { Equal } from "effect"
import type { ParsedFile } from "./changesView"

export interface TourChapter {
  readonly index: number
  readonly title: string
  readonly explanation: string
  readonly paths: ReadonlyArray<string>
  readonly diagram: TourDiagram | null
  readonly callTree: TourCallTree | null
  readonly callouts: TourCallouts
}

export interface TourReading {
  readonly writtenAt: Tour["writtenAt"]
  readonly intent: string
  readonly chapters: ReadonlyArray<TourChapter>
  readonly files: ReadonlyArray<ParsedFile>
  readonly summaries: ReadonlyMap<string, string>
  readonly chapterOf: ReadonlyMap<string, number>
}

export const readTour = (
  changed: ReadonlyArray<ParsedFile>,
  tour: Tour,
  revision: Revision,
): TourReading => {
  const current = Equal.equals(tour.revision, revision)
  const byPath = new Map(changed.map((entry) => [entry.file.path, entry]))
  const files: Array<ParsedFile> = []
  const placed = new Set<string>()
  const summaries = new Map<string, string>()
  const chapterOf = new Map<string, number>()

  const place = (path: string) => {
    const entry = byPath.get(path)

    if (entry === undefined || placed.has(path)) return false

    placed.add(path)
    files.push(entry)

    return true
  }

  const chapters = tour.chapters.map((chapter, index): TourChapter => {
    const paths = chapter.files.flatMap(({ path, summary }) => {
      if (!place(path)) return []

      summaries.set(path, summary)
      chapterOf.set(path, index)

      return [path]
    })

    const diagram = chapter.diagram ?? null

    return {
      index,
      title: chapter.title,
      explanation: chapter.explanation,
      paths,
      diagram:
        current &&
        diagram !== null &&
        diagram.nodes.every((node) => paths.includes(node.target.path))
          ? diagram
          : null,
      callTree:
        current &&
        chapter.callTree != null &&
        chapter.callTree.every((node) => paths.includes(node.target.path))
          ? chapter.callTree
          : null,
      callouts: current
        ? (chapter.callouts ?? []).filter((callout) => paths.includes(callout.target.path))
        : [],
    }
  })

  for (const path of [...tour.everythingElse, ...changed.map((entry) => entry.file.path)])
    place(path)

  return {
    writtenAt: tour.writtenAt,
    intent: tour.intent,
    chapters,
    files,
    summaries,
    chapterOf,
  }
}

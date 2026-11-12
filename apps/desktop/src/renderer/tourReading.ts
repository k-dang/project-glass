import type {
  AgentReview,
  Hotspot,
  Revision,
  Tour,
  TourBeforeAfter,
  TourCallouts,
  TourCodeTarget,
  TourDiagram,
} from "@glass/contracts"
import { Equal } from "effect"
import type { ParsedFile } from "./changesView"
import { rankHotspots } from "./rankedHotspots"

export type TourHotspot =
  | { readonly rank: number; readonly hotspot: Hotspot; readonly chapter: null }
  | {
      readonly rank: number
      readonly hotspot: Hotspot & { readonly place: TourCodeTarget }
      readonly chapter: number
    }

export type ChapterHotspot = Extract<TourHotspot, { readonly chapter: number }>

export interface TourChapter {
  readonly index: number
  readonly title: string
  readonly explanation: string
  readonly paths: ReadonlyArray<string>
  readonly diagram: TourDiagram | null
  readonly beforeAfter: TourBeforeAfter | null
  readonly callouts: TourCallouts
  readonly hotspots: ReadonlyArray<ChapterHotspot>
  readonly lowAttention: boolean
}

export interface TourReading {
  readonly writtenAt: Tour["writtenAt"]
  readonly intent: string
  readonly beforeAfter: TourBeforeAfter | null
  readonly hotspots: ReadonlyArray<TourHotspot> | null
  readonly chapters: ReadonlyArray<TourChapter>
  readonly files: ReadonlyArray<ParsedFile>
  readonly summaries: ReadonlyMap<string, string>
  readonly chapterOf: ReadonlyMap<string, number>
}

export const readTour = (
  changed: ReadonlyArray<ParsedFile>,
  tour: Tour,
  revision: Revision,
  currentReview: AgentReview | null,
): TourReading => {
  const current = Equal.equals(tour.revision, revision)
  const review = current ? currentReview : null
  const lowAttention = new Set(review?.lowAttention.map(({ path }) => path))
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

  const shownBeforeAfter = (
    beforeAfter: TourBeforeAfter | null | undefined,
    inScope: (path: string) => boolean,
  ) =>
    current &&
    beforeAfter != null &&
    beforeAfter.lines.every(({ target }) => target === null || inScope(target.path))
      ? beforeAfter
      : null

  const placedChapters = tour.chapters.map((chapter, index) => {
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
      beforeAfter: shownBeforeAfter(chapter.beforeAfter, (path) => paths.includes(path)),
      callouts: current
        ? (chapter.callouts ?? []).filter((callout) => paths.includes(callout.target.path))
        : [],
      lowAttention: paths.length > 0 && paths.every((path) => lowAttention.has(path)),
    }
  })

  const hotspots =
    review === null
      ? null
      : rankHotspots(review.hotspots).map(({ rank, hotspot }): TourHotspot => {
          const lines = hotspot.place
          const chapter = lines === null ? undefined : chapterOf.get(lines.path)

          return lines === null || chapter === undefined
            ? { rank, hotspot, chapter: null }
            : { rank, hotspot: { ...hotspot, place: lines }, chapter }
        })

  const chapters = placedChapters.map((chapter): TourChapter => ({
    ...chapter,
    hotspots: (hotspots ?? []).filter(
      (entry): entry is ChapterHotspot => entry.chapter === chapter.index,
    ),
  }))

  for (const path of [...tour.everythingElse, ...changed.map((entry) => entry.file.path)])
    place(path)

  return {
    writtenAt: tour.writtenAt,
    intent: tour.intent,
    beforeAfter: shownBeforeAfter(tour.beforeAfter, (path) => byPath.has(path)),
    hotspots,
    chapters,
    files,
    summaries,
    chapterOf,
  }
}

export const hasOverview = (reading: TourReading) =>
  reading.beforeAfter !== null || reading.hotspots !== null

import type { DiffSide, FeedbackNote } from "@glass/contracts"
import type { DiffLineAnnotation, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs"
import {
  annotationSides,
  type FileAnnotations,
  groupByPath,
  hunkHolding,
  shownRanges,
  sideOf,
} from "./changesView"

export type FeedbackTarget = Pick<FeedbackNote, "side" | "start" | "end" | "code">

export const feedbackTarget = (
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
): FeedbackTarget | null => {
  if (range.endSide !== undefined && range.endSide !== (range.side ?? "additions")) return null

  const side = sideOf(range.side)
  const start = Math.min(range.start, range.end)
  const end = Math.max(range.start, range.end)
  const hunk = shownRanges(fileDiff, side)[hunkHolding(fileDiff, side, start)]

  if (hunk === undefined || end >= hunk.first + hunk.count) return null

  const lines = side === "new" ? fileDiff.additionLines : fileDiff.deletionLines
  const from = hunk.index + start - hunk.first

  const code = lines
    .slice(from, from + end - start + 1)
    .map((line) => line.replace(/\r?\n$/, ""))
    .join("\n")

  return { side, start, end, code }
}

export const nextSelection = (
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
  step: 1 | -1,
): SelectedLineRange | null => {
  const side = sideOf(range.side)
  const hunks = shownRanges(fileDiff, side)
  const at = hunkHolding(fileDiff, side, range.end)
  const hunk = hunks[at]
  const moved = (end: number) => ({ ...range, end, endSide: range.side ?? "additions" })

  if (hunk === undefined) return null

  const within = range.end + step

  if (within >= hunk.first && within < hunk.first + hunk.count) return moved(within)

  const next = hunks[at + step]

  if (next === undefined) return null

  return moved(step === 1 ? next.first : next.first + next.count - 1)
}

export const firstSelection = (fileDiff: FileDiffMetadata): SelectedLineRange | null => {
  for (const side of ["new", "old"] as const) {
    const first = shownRanges(fileDiff, side).find(({ count }) => count > 0)

    if (first !== undefined)
      return { start: first.first, end: first.first, side: annotationSides[side] }
  }

  return null
}

export type FeedbackAnnotation =
  | { readonly type: "note"; readonly id: string }
  | { readonly type: "editor" }
  | { readonly type: "selection" }

export type FeedbackExtra = Pick<FeedbackNote, "path" | "side" | "end"> &
  ({ readonly type: "selection" } | { readonly type: "editor"; readonly id: string })

export const isOlder = (note: Pick<FeedbackNote, "changesId">, changesId: string | null) =>
  note.changesId !== changesId

export const feedbackAnnotations = (
  notes: ReadonlyArray<FeedbackNote>,
  changesId: string | null,
  extra: FeedbackExtra | null,
) => {
  const editedId = extra?.type === "editor" ? extra.id : null

  const shown = groupByPath(
    notes.filter((note) => !isOlder(note, changesId) && note.id !== editedId),
    (note) => note.path,
  )

  return (path: string): FileAnnotations<FeedbackAnnotation> => {
    const annotations = (shown.get(path) ?? []).map(
      (note): DiffLineAnnotation<FeedbackAnnotation> => ({
        side: annotationSides[note.side],
        lineNumber: note.end,
        metadata: { type: "note", id: note.id },
      }),
    )

    if (extra?.path === path) {
      const at = { side: annotationSides[extra.side], lineNumber: extra.end }

      annotations.push(
        extra.type === "editor"
          ? { ...at, metadata: { type: "editor" } }
          : { ...at, metadata: { type: "selection" } },
      )
    }

    return { annotations, drawn: annotations }
  }
}

const rangeLines = (start: number, end: number) =>
  start === end ? `line ${start}` : `lines ${start}–${end}`

export const rangeLabel = (side: DiffSide, start: number, end: number) =>
  `${side === "new" ? "New" : "Old"} ${rangeLines(start, end)}`

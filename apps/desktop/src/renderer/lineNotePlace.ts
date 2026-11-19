import type { DiffSide } from "@glass/contracts"

export interface LineNotePlace {
  readonly key: string
  readonly path: string
  readonly side: DiffSide
  readonly line: number
}

export const sameLineNotePlaces = (
  previous: ReadonlyArray<LineNotePlace>,
  next: ReadonlyArray<LineNotePlace>,
) =>
  previous.length === next.length &&
  previous.every((place, index) => {
    const other = next[index]!

    return (
      place.key === other.key &&
      place.path === other.path &&
      place.side === other.side &&
      place.line === other.line
    )
  })

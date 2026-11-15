import type { ToDo } from "@glass/contracts"

export const toDoLayouts = ["current", "newest", "reorder", "sections"] as const

export type ToDoLayout = (typeof toDoLayouts)[number]

export const toDoLayoutLabel: Record<ToDoLayout, string> = {
  current: "Current",
  newest: "Newest",
  reorder: "Reorder",
  sections: "Sections",
}

export const isToDoLayout = (value: string): value is ToDoLayout =>
  toDoLayouts.some((layout) => layout === value)

export const openToDos = (toDos: ReadonlyArray<ToDo>) => toDos.filter((toDo) => !toDo.done)

export const doneToDos = (toDos: ReadonlyArray<ToDo>) => toDos.filter((toDo) => toDo.done)

/** The server lists open to-dos oldest first, by id. */
export const newestFirst = (toDos: ReadonlyArray<ToDo>) =>
  toDos.toSorted((left, right) => right.id - left.id)

const hasNotes = (toDo: ToDo) => toDo.notes.trim() !== ""

export const checklistToDos = (open: ReadonlyArray<ToDo>) => open.filter((toDo) => !hasNotes(toDo))

export const notedToDos = (open: ReadonlyArray<ToDo>) => newestFirst(open.filter(hasNotes))

/**
 * Keeps a manual order of the to-dos that are still open, and appends any the
 * order has not seen yet in the server's added order.
 */
export const reconcileOrder = (
  open: ReadonlyArray<ToDo>,
  order: ReadonlyArray<number>,
): ReadonlyArray<number> => {
  const live = new Set(open.map((toDo) => toDo.id))
  const kept: Array<number> = []
  const seen = new Set<number>()

  for (const id of order) {
    if (!live.has(id) || seen.has(id)) continue

    kept.push(id)
    seen.add(id)
  }

  for (const toDo of open) {
    if (seen.has(toDo.id)) continue

    kept.push(toDo.id)
  }

  return kept
}

export const orderedBy = (open: ReadonlyArray<ToDo>, order: ReadonlyArray<number>) => {
  const byId = new Map(open.map((toDo) => [toDo.id, toDo]))
  const placed: Array<ToDo> = []

  for (const id of reconcileOrder(open, order)) {
    const toDo = byId.get(id)

    if (toDo !== undefined) placed.push(toDo)
  }

  return placed
}

/** `before === null` moves `id` to the end. */
export const moveBefore = (
  order: ReadonlyArray<number>,
  id: number,
  before: number | null,
): ReadonlyArray<number> => {
  if (before === id) return order

  const next: Array<number> = []
  let placed = false

  for (const item of order) {
    if (item === id) continue

    if (item === before) {
      next.push(id)
      placed = true
    }

    next.push(item)
  }

  if (!placed) next.push(id)

  return next
}

export const moveBy = (order: ReadonlyArray<number>, id: number, delta: -1 | 1) => {
  const index = order.indexOf(id)
  const target = index + delta

  if (index < 0 || target < 0 || target >= order.length) return order

  const neighbor = order[target]

  if (neighbor === undefined) return order

  const before = delta < 0 ? neighbor : (order[target + 1] ?? null)

  return moveBefore(order, id, before)
}

export interface NotePart {
  readonly kind: "text" | "link"
  readonly value: string
}

const URL_IN_NOTES = /https?:\/\/[^\s<>]+/g

const withoutTrailingPunctuation = (url: string) => url.replace(/[),.;:]+$/u, "")

export const noteParts = (notes: string): ReadonlyArray<NotePart> => {
  const parts: Array<NotePart> = []
  let cursor = 0

  for (const match of notes.matchAll(URL_IN_NOTES)) {
    const index = match.index
    const raw = match[0]

    if (index === undefined) continue

    if (index > cursor) parts.push({ kind: "text", value: notes.slice(cursor, index) })

    const value = withoutTrailingPunctuation(raw)
    parts.push({ kind: "link", value })

    const trailing = raw.slice(value.length)

    if (trailing !== "") parts.push({ kind: "text", value: trailing })

    cursor = index + raw.length
  }

  if (cursor < notes.length) parts.push({ kind: "text", value: notes.slice(cursor) })

  return parts
}

const LINK_LABEL_LIMIT = 64

export const linkLabel = (url: string) => {
  const parsed = URL.parse(url)

  if (parsed === null) return url

  const path = parsed.pathname === "/" ? "" : `${parsed.pathname}${parsed.hash}`
  const full = `${parsed.hostname}${path}`

  if (full.length <= LINK_LABEL_LIMIT) return full

  const leaf = parsed.pathname.split("/").findLast((part) => part !== "") ?? ""
  const shortened = leaf === "" ? parsed.hostname : `${parsed.hostname}/…/${leaf}${parsed.hash}`

  return shortened.length <= LINK_LABEL_LIMIT
    ? shortened
    : `${shortened.slice(0, LINK_LABEL_LIMIT - 1)}…`
}

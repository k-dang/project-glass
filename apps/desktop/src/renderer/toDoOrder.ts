import type { ToDo } from "@glass/contracts"

/** The server lists open to-dos oldest first, by id. The page shows the reverse. */
export const newestFirst = (toDos: ReadonlyArray<ToDo>) =>
  toDos.toSorted((left, right) => right.id - left.id)

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

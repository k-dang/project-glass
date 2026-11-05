import type { ToDo } from "./toDo"

export type Mentioned =
  | ({ readonly kind: "toDo" } & Pick<ToDo, "id" | "title">)
  | { readonly kind: "file"; readonly path: string }

const MENTION = /\[([^[\]\n]+)\]\(glass:\/\/(to-do|file)\/([^\s()]+)\)/g

const linkSafe = (text: string, fallback: string) =>
  text.replaceAll(/[[\]\s]+/g, " ").trim() || fallback

export const toDoMention = ({ id, title }: Pick<ToDo, "id" | "title">) =>
  `[${linkSafe(title, "To-do")}](glass://to-do/${id})`

const encodedSegment = (segment: string) =>
  encodeURIComponent(segment).replaceAll("(", "%28").replaceAll(")", "%29")

export const fileMention = (path: string) =>
  `[${linkSafe(path, "File")}](glass://file/${path.split("/").map(encodedSegment).join("/")})`

const decodedPath = (ref: string) => {
  try {
    return decodeURIComponent(ref)
  } catch {
    return undefined
  }
}

const parsed = (kind: string, label: string, ref: string): Mentioned | undefined => {
  if (kind === "file") {
    const path = decodedPath(ref)

    return path === undefined ? undefined : { kind: "file", path }
  }

  return /^\d+$/.test(ref) ? { kind: "toDo", id: Number(ref), title: label } : undefined
}

export const mapMentions = <A>(
  text: string,
  write: {
    readonly text: (text: string, key: number) => A
    readonly mention: (mentioned: Mentioned, key: number, link: string) => A
  },
): ReadonlyArray<A> => {
  const pieces: Array<A> = []
  let from = 0

  for (const { 0: link, 1: label = "", 2: kind = "", 3: ref = "", index } of text.matchAll(
    MENTION,
  )) {
    const found = parsed(kind, label, ref)

    if (found === undefined) continue

    if (index > from) pieces.push(write.text(text.slice(from, index), from))
    pieces.push(write.mention(found, index, link))
    from = index + link.length
  }

  if (from < text.length) pieces.push(write.text(text.slice(from), from))

  return pieces
}

export const mentionLink = (mentioned: Mentioned) =>
  mentioned.kind === "toDo" ? toDoMention(mentioned) : fileMention(mentioned.path)

export const replaceMentions = (text: string, write: (mentioned: Mentioned) => string) =>
  mapMentions(text, { text: (piece) => piece, mention: write }).join("")

export const mentionsIn = (text: string): ReadonlyArray<Mentioned> =>
  mapMentions<Mentioned | null>(text, {
    text: () => null,
    mention: (mentioned) => mentioned,
  }).filter((mentioned) => mentioned !== null)

export const mentionedToDoIds = (text: string): ReadonlyArray<number> => [
  ...new Set(
    mentionsIn(text).flatMap((mentioned) => (mentioned.kind === "toDo" ? [mentioned.id] : [])),
  ),
]

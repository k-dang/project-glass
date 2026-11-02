import type { ToDo } from "./toDo"

type Mentioned = Pick<ToDo, "id" | "title">

const MENTION = /\[([^[\]\n]+)\]\(glass:\/\/to-do\/(\d+)\)/g

const linkSafeTitle = (title: string) => title.replaceAll(/[[\]\s]+/g, " ").trim() || "To-do"

export const toDoMention = ({ id, title }: Mentioned) =>
  `[${linkSafeTitle(title)}](glass://to-do/${id})`

export const mapMentions = <A>(
  text: string,
  write: {
    readonly text: (text: string, key: number) => A
    readonly mention: (mentioned: Mentioned, key: number) => A
  },
): ReadonlyArray<A> => {
  const pieces: Array<A> = []
  let from = 0

  for (const { 0: link, 1: title = "", 2: id, index } of text.matchAll(MENTION)) {
    if (index > from) pieces.push(write.text(text.slice(from, index), from))
    pieces.push(write.mention({ id: Number(id), title }, index))
    from = index + link.length
  }

  if (from < text.length) pieces.push(write.text(text.slice(from), from))

  return pieces
}

export const replaceMentions = (text: string, write: (mentioned: Mentioned) => string) =>
  text.replaceAll(MENTION, (_link, title: string, id: string) => write({ id: Number(id), title }))

export const mentionedToDoIds = (text: string): ReadonlyArray<number> => [
  ...new Set(Array.from(text.matchAll(MENTION), (match) => Number(match[2]))),
]

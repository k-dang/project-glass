import { Data } from "effect"
import type { ToDo } from "./toDo"

/**
 * A Mention is a Markdown link in a message to an Agent: `[title](glass://to-do/<id>)`. The id is
 * the To-do's identity; the title is what the user saw when they mentioned it, kept for display.
 */
type Mentioned = Pick<ToDo, "id" | "title">

const MENTION = /\[([^[\]\n]+)\]\(glass:\/\/to-do\/(\d+)\)/g

/** A title with the brackets and line breaks that would end its link taken out. */
const label = (title: string) => title.replaceAll(/[[\]\s]+/g, " ").trim() || "To-do"

export const toDoMention = ({ id, title }: Mentioned) => `[${label(title)}](glass://to-do/${id})`

export type MessagePiece = Data.TaggedEnum<{
  Text: { readonly text: string }
  Mention: Mentioned
}>

export const MessagePiece = Data.taggedEnum<MessagePiece>()

/** The message's text, split around its Mentions. */
export const splitMentions = (text: string): ReadonlyArray<MessagePiece> => {
  const pieces: Array<MessagePiece> = []
  let from = 0

  for (const { 0: link, 1: title = "", 2: id, index: at } of text.matchAll(MENTION)) {
    if (at > from) pieces.push(MessagePiece.Text({ text: text.slice(from, at) }))
    pieces.push(MessagePiece.Mention({ id: Number(id), title }))
    from = at + link.length
  }

  if (from < text.length) pieces.push(MessagePiece.Text({ text: text.slice(from) }))

  return pieces
}

/** The message's text with each Mention written as `write` puts it. */
export const replaceMentions = (text: string, write: (mentioned: Mentioned) => string) =>
  text.replaceAll(MENTION, (_link, title: string, id: string) => write({ id: Number(id), title }))

/** The ids of the To-dos the message mentions, each once, in the order they first appear. */
export const mentionedToDoIds = (text: string): ReadonlyArray<number> => [
  ...new Set(Array.from(text.matchAll(MENTION), (match) => Number(match[2]))),
]

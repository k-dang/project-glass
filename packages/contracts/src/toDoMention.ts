import { Data } from "effect"

/**
 * A Mention is a Markdown link in a message to an Agent: `[title](glass://to-do/<id>)`. The id is
 * the To-do's identity; the title is what the user saw when they mentioned it, kept for display.
 */
export interface ToDoMention {
  readonly id: number
  readonly title: string
}

const MENTION = /\[([^[\]\n]+)\]\(glass:\/\/to-do\/(\d+)\)/g

/** A title with the brackets and line breaks that would end its link taken out. */
const label = (title: string) => title.replaceAll(/[[\]\s]+/g, " ").trim() || "To-do"

export const toDoMention = ({ id, title }: ToDoMention) => `[${label(title)}](glass://to-do/${id})`

export type MessagePiece = Data.TaggedEnum<{
  Text: { readonly text: string }
  Mention: ToDoMention
}>

export const MessagePiece = Data.taggedEnum<MessagePiece>()

/** The message's text, split around its Mentions. */
export const splitMentions = (text: string): ReadonlyArray<MessagePiece> => {
  const pieces: Array<MessagePiece> = []
  let from = 0

  for (const [link, title = "", id] of text.matchAll(MENTION)) {
    const at = text.indexOf(link, from)

    if (at > from) pieces.push(MessagePiece.Text({ text: text.slice(from, at) }))
    pieces.push(MessagePiece.Mention({ id: Number(id), title }))
    from = at + link.length
  }

  if (from < text.length) pieces.push(MessagePiece.Text({ text: text.slice(from) }))

  return pieces
}

/** The ids of the To-dos the message mentions, each once, in the order they first appear. */
export const mentionedToDoIds = (text: string): ReadonlyArray<number> => [
  ...new Set(Array.from(text.matchAll(MENTION), (match) => Number(match[2]))),
]

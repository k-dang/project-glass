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

/**
 * The message's text and Mentions in order, each written as `write` puts it. `at` tells pieces
 * apart, such as for React keys.
 */
export const mapMentions = <A>(
  text: string,
  write: {
    readonly text: (text: string, at: number) => A
    readonly mention: (mentioned: Mentioned, at: number) => A
  },
): ReadonlyArray<A> => {
  // Splitting on a pattern with two groups gives text, title, id, text, title, id, …, text.
  const parts = text.split(MENTION)
  const pieces: Array<A> = []

  for (let at = 0; at < parts.length; at += 3) {
    const [between = "", title, id] = parts.slice(at, at + 3)

    if (between !== "") pieces.push(write.text(between, at))

    if (title !== undefined) pieces.push(write.mention({ id: Number(id), title }, at + 1))
  }

  return pieces
}

/** The message's text with each Mention written as `write` puts it. */
export const replaceMentions = (text: string, write: (mentioned: Mentioned) => string) =>
  text.replaceAll(MENTION, (_link, title: string, id: string) => write({ id: Number(id), title }))

/** The ids of the To-dos the message mentions, each once, in the order they first appear. */
export const mentionedToDoIds = (text: string): ReadonlyArray<number> => [
  ...new Set(Array.from(text.matchAll(MENTION), (match) => Number(match[2]))),
]

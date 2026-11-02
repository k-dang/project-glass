import { MessagePiece, splitMentions, type ToDo, toDoMention } from "@glass/contracts"
import { ListTodo } from "lucide-react"
import { Fragment } from "react"
import { cn } from "cn"

/** A message's text as the user reads it: each Mention shows as its To-do's title. */
export const readableText = (message: string) =>
  splitMentions(message)
    .map(MessagePiece.$match({ Text: ({ text }) => text, Mention: ({ title }) => title }))
    .join("")

export function MessageText(props: { text: string }) {
  return splitMentions(props.text).map((piece, index) =>
    MessagePiece.$match(piece, {
      Text: ({ text }) => <Fragment key={index}>{text}</Fragment>,
      Mention: ({ title }) => (
        <span
          key={index}
          data-slot="mention"
          className="inline-flex items-baseline gap-1 rounded-sm bg-background/70 px-1 font-medium"
        >
          <ListTodo aria-hidden className="size-3.5 shrink-0 self-center" />
          {title}
        </span>
      ),
    }),
  )
}

const TRIGGER = /(?:^|\s)@([^\s@[\]()]*)$/

/** The `@` the user is typing a Mention from, ending at the caret, and the text after it. */
export const mentionTrigger = (text: string, caret: number) => {
  const typed = TRIGGER.exec(text.slice(0, caret))?.[1]

  return typed === undefined ? null : { start: caret - typed.length - 1, query: typed }
}

const MENTION_CHOICES = 6

export const mentionChoices = (toDos: ReadonlyArray<ToDo>, query: string) => {
  const wanted = query.toLowerCase()

  return toDos.filter(({ title }) => title.toLowerCase().includes(wanted)).slice(0, MENTION_CHOICES)
}

/** The text with the trigger replaced by the To-do's Mention, and where the caret goes after it. */
export const mention = (text: string, trigger: { start: number }, caret: number, toDo: ToDo) => {
  const inserted = `${toDoMention(toDo)} `

  return {
    text: text.slice(0, trigger.start) + inserted + text.slice(caret),
    caret: trigger.start + inserted.length,
  }
}

/**
 * The To-dos the user can mention, as the ARIA combobox pattern lists them: focus stays in the
 * composer, whose keys move through and choose these options, so they take no focus of their own
 * and a native select, which can't follow the caret, doesn't fit.
 */
export function MentionChoices(props: {
  id: string
  choices: ReadonlyArray<ToDo>
  highlighted: number
  onChoose: (toDo: ToDo) => void
}) {
  return (
    <div
      id={props.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
      role="listbox"
      aria-label="To-dos"
      className="flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {props.choices.map((toDo, index) => (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- See the combobox pattern above.
        <div
          key={toDo.id}
          id={`${props.id}-${toDo.id}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
          role="option"
          aria-selected={index === props.highlighted}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            index === props.highlighted && "bg-accent text-accent-foreground",
          )}
          // Keeps focus, and with it the caret, in the composer.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.onChoose(toDo)}
        >
          <ListTodo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{toDo.title}</span>
        </div>
      ))}
    </div>
  )
}

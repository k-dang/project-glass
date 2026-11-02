import { useAtomValue } from "@effect/atom-react"
import { mapMentions, replaceMentions, type ToDo, toDoMention } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { ListTodo } from "lucide-react"
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  type SyntheticEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { cn } from "cn"
import { openToDosAtom } from "./toDoList"

export const readableText = (message: string) => replaceMentions(message, ({ title }) => title)

export function MessageText(props: { text: string }) {
  return mapMentions(props.text, {
    text: (text, key) => <Fragment key={key}>{text}</Fragment>,
    mention: ({ title }, key) => (
      <span
        key={key}
        data-slot="mention"
        className="inline-flex items-baseline gap-1 rounded-sm bg-background/70 px-1 font-medium"
      >
        <ListTodo aria-hidden className="size-3.5 shrink-0 self-center" />
        {title}
      </span>
    ),
  })
}

const TRIGGER = /(?:^|\s)@([^\s@[\]()]*)$/

const MAX_CHOICES = 6

interface CaretInText {
  readonly text: string
  readonly caret: number
}

interface Picking {
  readonly start: number
  readonly caret: number
  readonly choices: ReadonlyArray<ToDo>
  readonly active: number
  readonly chosen: ToDo
}

const throughTrigger = (message: string, start: number) => message.slice(0, start + 1)

const picking = (
  message: string,
  measured: CaretInText,
  dismissedThroughTrigger: string | null,
  toDos: ReadonlyArray<ToDo>,
  highlighted: number,
): Picking | null => {
  const caretIsInMessage = measured.text === message

  if (!caretIsInMessage) return null

  const { caret } = measured
  const typed = TRIGGER.exec(message.slice(0, caret))?.[1]

  if (typed === undefined) return null

  const start = caret - typed.length - 1

  if (dismissedThroughTrigger === throughTrigger(message, start)) return null

  const wanted = typed.toLowerCase()

  const choices = toDos
    .filter(({ title }) => title.toLowerCase().includes(wanted))
    .slice(0, MAX_CHOICES)

  const active = Math.min(highlighted, choices.length - 1)
  const chosen = choices[active]

  return chosen === undefined ? null : { start, caret, choices, active, chosen }
}

const insertMention = (message: string, { start, caret }: Picking, toDo: ToDo): CaretInText => {
  const after = message.slice(caret)
  const link = toDoMention(toDo)
  const spaced = /^\s/.test(after) ? link : `${link} `

  return { text: message.slice(0, start) + spaced + after, caret: start + link.length + 1 }
}

export function useMentionPicker(message: string, setMessage: (message: string) => void) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const [measured, setMeasured] = useState<CaretInText>({ text: "", caret: 0 })
  const [highlighted, setHighlighted] = useState(0)
  const [dismissedThroughTrigger, setDismissedThroughTrigger] = useState<string | null>(null)
  const nextCaret = useRef<number | null>(null)
  const openToDos = Option.getOrElse(AsyncResult.value(useAtomValue(openToDosAtom)), () => [])
  const open = picking(message, measured, dismissedThroughTrigger, openToDos, highlighted)

  useLayoutEffect(() => {
    if (nextCaret.current === null) return
    ref.current?.setSelectionRange(nextCaret.current, nextCaret.current)
    nextCaret.current = null
  })

  const follow = ({ value, selectionEnd }: HTMLTextAreaElement) => {
    setMeasured((current) =>
      current.text === value && current.caret === selectionEnd
        ? current
        : { text: value, caret: selectionEnd },
    )
    setHighlighted(0)
  }

  const choose = (toDo: ToDo) => {
    if (open === null) return
    const next = insertMention(message, open, toDo)
    nextCaret.current = next.caret
    setMeasured(next)
    setMessage(next.text)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (open === null) return false

    const { choices, active, chosen } = open

    if (event.key === "ArrowDown") setHighlighted((active + 1) % choices.length)
    else if (event.key === "ArrowUp") setHighlighted((active + choices.length - 1) % choices.length)
    else if (event.key === "Enter" || event.key === "Tab") choose(chosen)
    else if (event.key === "Escape") setDismissedThroughTrigger(throughTrigger(message, open.start))
    else return false

    event.preventDefault()

    return true
  }

  return {
    textarea: {
      ref,
      "aria-controls": open === null ? undefined : id,
      "aria-activedescendant": open === null ? undefined : `${id}-${open.chosen.id}`,
      onSelect: (event: SyntheticEvent<HTMLTextAreaElement>) => follow(event.currentTarget),
    },
    follow,
    onKeyDown,
    choices: open === null ? null : <MentionChoices id={id} open={open} onChoose={choose} />,
  }
}

const keepComposerFocus = (event: MouseEvent) => event.preventDefault()

/**
 * WAI-ARIA APG combobox: focus stays in the composer textarea, which drives these options through
 * `aria-activedescendant`, so they take no focus. A native `select` would take focus, and
 * `datalist` can't attach to a textarea.
 */
function MentionChoices(props: { id: string; open: Picking; onChoose: (toDo: ToDo) => void }) {
  return (
    <div
      id={props.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
      role="listbox"
      aria-label="To-dos"
      className="flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {props.open.choices.map((toDo, index) => (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- See the combobox pattern above.
        <div
          key={toDo.id}
          id={`${props.id}-${toDo.id}`}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
          role="option"
          aria-selected={index === props.open.active}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            index === props.open.active && "bg-accent text-accent-foreground",
          )}
          onMouseDown={keepComposerFocus}
          onClick={() => props.onChoose(toDo)}
        >
          <ListTodo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{toDo.title}</span>
        </div>
      ))}
    </div>
  )
}

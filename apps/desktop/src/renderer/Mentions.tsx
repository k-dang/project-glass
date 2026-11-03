import { useAtomValue } from "@effect/atom-react"
import { mapMentions, replaceMentions, type ToDo, toDoMention } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type Editor, useEditorState } from "@tiptap/react"
import { ListTodo } from "lucide-react"
import { Fragment, type MouseEvent, useId, useState } from "react"
import { cn } from "cn"
import { CHIP, ToDoMention } from "./composerDocument"
import { MentionChip } from "./MentionChip"
import { openToDosAtom } from "./toDoList"

export const readableText = (message: string) => replaceMentions(message, ({ title }) => title)

export function MessageText(props: { text: string }) {
  return mapMentions(props.text, {
    text: (text, key) => <Fragment key={key}>{text}</Fragment>,
    mention: ({ title }, key) => <MentionChip key={key} title={title} />,
  })
}

const TRIGGER = /(?:^|\s)@([^\s@[\]()]*)$/

const MAX_CHOICES = 6

interface Caret {
  readonly before: string
  readonly at: number
}

const caretOf = ({ editor }: { editor: Editor }): Caret => {
  const { $head } = editor.state.selection

  return { before: $head.parent.textBetween(0, $head.parentOffset, undefined, CHIP), at: $head.pos }
}

const sameCaret = (a: Caret, b: Caret | null) => a.before === b?.before && a.at === b.at

interface Picking {
  readonly from: number
  readonly to: number
  readonly trigger: string
  readonly choices: ReadonlyArray<ToDo>
  readonly active: number
  readonly chosen: ToDo
}

const throughTrigger = (editor: Editor, from: number) =>
  editor.state.doc.textBetween(0, from + 1, "\n", CHIP)

const picking = (
  editor: Editor,
  caret: Caret,
  dismissedThroughTrigger: string | null,
  toDos: ReadonlyArray<ToDo>,
  highlighted: number,
): Picking | null => {
  const typed = TRIGGER.exec(caret.before)?.[1]

  if (typed === undefined) return null

  const from = caret.at - typed.length - 1
  const trigger = throughTrigger(editor, from)

  if (dismissedThroughTrigger === trigger) return null

  const wanted = typed.toLowerCase()

  const choices = toDos
    .filter(({ title }) => title.toLowerCase().includes(wanted))
    .slice(0, MAX_CHOICES)

  const active = Math.min(highlighted, choices.length - 1)
  const chosen = choices[active]

  return chosen === undefined ? null : { from, to: caret.at, trigger, choices, active, chosen }
}

const insertMention = (editor: Editor, { from, to }: Picking, { id, title }: ToDo) => {
  const after = editor.state.doc.resolve(to).nodeAfter
  const spaced = after?.isText === true && /^\s/.test(after.text ?? "")

  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, [
      { type: ToDoMention.name, attrs: { title, link: toDoMention({ id, title }) } },
      ...(spaced ? [] : [{ type: "text", text: " " }]),
    ])
    .setTextSelection(from + 2)
    .run()
}

export function useMentionPicker(editor: Editor, enabled: boolean) {
  const id = useId()

  const caret = useEditorState({
    editor,
    selector: caretOf,
    equalityFn: sameCaret,
  })

  const [highlight, setHighlight] = useState({ caret, index: 0 })
  const highlighted = highlight.caret === caret ? highlight.index : 0
  const [dismissedThroughTrigger, setDismissedThroughTrigger] = useState<string | null>(null)
  const openToDos = Option.getOrElse(AsyncResult.value(useAtomValue(openToDosAtom)), () => [])

  const open = enabled
    ? picking(editor, caret, dismissedThroughTrigger, openToDos, highlighted)
    : null

  const choose = (toDo: ToDo) => {
    if (open === null) return
    insertMention(editor, open, toDo)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (open === null) return false

    const { choices, active, chosen } = open

    if (event.key === "ArrowDown") setHighlight({ caret, index: (active + 1) % choices.length })
    else if (event.key === "ArrowUp")
      setHighlight({ caret, index: (active + choices.length - 1) % choices.length })
    else if (event.key === "Enter" || event.key === "Tab") choose(chosen)
    else if (event.key === "Escape") setDismissedThroughTrigger(open.trigger)
    else return false

    event.preventDefault()

    return true
  }

  return {
    activeDescendant: open === null ? null : `${id}-${open.chosen.id}`,
    listbox: id,
    onKeyDown,
    choices: open === null ? null : <MentionChoices id={id} open={open} onChoose={choose} />,
  }
}

const keepComposerFocus = (event: MouseEvent) => event.preventDefault()

/**
 * WAI-ARIA APG combobox: focus stays in the composer, which drives these options through
 * `aria-activedescendant`, so they take no focus. A native `select` would take focus, and
 * `datalist` can't attach to an editor.
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

import { type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { type Editor, useEditorState } from "@tiptap/react"
import { type MouseEvent, type ReactNode, useId, useState } from "react"
import { cn } from "cn"
import { CHIP } from "./composerDocument"

const MAX_CHOICES = 6

export interface Caret {
  readonly before: string
  readonly at: number
}

const caretOf = ({ editor }: { editor: Editor }): Caret => {
  const { $head } = editor.state.selection

  return { before: $head.parent.textBetween(0, $head.parentOffset, undefined, CHIP), at: $head.pos }
}

const sameCaret = (a: Caret, b: Caret | null) => a.before === b?.before && a.at === b.at

export interface Range {
  readonly from: number
  readonly to: number
}

export interface PickerSource<T> {
  readonly label: string
  readonly typed: (caret: Caret, doc: ProseMirrorNode) => string | undefined
  readonly choices: (typed: string) => ReadonlyArray<T>
  readonly key: (choice: T) => string
  readonly insert: (editor: Editor, range: Range, choice: T) => void
  readonly render: (choice: T) => ReactNode
}

interface Open<T> extends Range {
  readonly source: PickerSource<T>
  readonly trigger: string
  readonly choices: ReadonlyArray<T>
  readonly active: number
  readonly chosen: T
}

const throughTrigger = (editor: Editor, from: number) =>
  editor.state.doc.textBetween(0, from + 1, "\n", CHIP)

const opened = <T,>(
  editor: Editor,
  caret: Caret,
  source: PickerSource<T>,
  dismissedThroughTrigger: string | null,
  highlighted: number,
): Open<T> | null => {
  const typed = source.typed(caret, editor.state.doc)

  if (typed === undefined) return null

  const from = caret.at - typed.length - 1
  const trigger = throughTrigger(editor, from)

  if (dismissedThroughTrigger === trigger) return null

  const choices = source.choices(typed.toLowerCase()).slice(0, MAX_CHOICES)
  const active = Math.min(highlighted, choices.length - 1)
  const chosen = choices[active]

  return chosen === undefined
    ? null
    : { from, to: caret.at, source, trigger, choices, active, chosen }
}

export function usePicker<T>(editor: Editor, source: PickerSource<T> | null) {
  const id = useId()

  const caret = useEditorState({
    editor,
    selector: caretOf,
    equalityFn: sameCaret,
  })

  const [highlight, setHighlight] = useState({ caret, index: 0 })
  const highlighted = highlight.caret === caret ? highlight.index : 0
  const [dismissedThroughTrigger, setDismissedThroughTrigger] = useState<string | null>(null)

  const open =
    source === null ? null : opened(editor, caret, source, dismissedThroughTrigger, highlighted)

  const choose = (choice: T) => {
    if (open !== null) open.source.insert(editor, open, choice)
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
    activeDescendant: open === null ? null : optionId(id, open, open.chosen),
    listbox: id,
    onKeyDown,
    choices: open === null ? null : <Choices id={id} open={open} onChoose={choose} />,
  }
}

const optionId = <T,>(listbox: string, { source }: Open<T>, choice: T) =>
  `${listbox}-${source.key(choice)}`

const keepComposerFocus = (event: MouseEvent) => event.preventDefault()

/**
 * WAI-ARIA APG combobox: focus stays in the composer, which drives these options through
 * `aria-activedescendant`, so they take no focus. A native `select` would take focus, and
 * `datalist` can't attach to an editor.
 */
function Choices<T>(props: { id: string; open: Open<T>; onChoose: (choice: T) => void }) {
  const { open } = props

  return (
    <div
      id={props.id}
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
      role="listbox"
      aria-label={open.source.label}
      className="flex flex-col gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {open.choices.map((choice, index) => (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- See the combobox pattern above.
        <div
          key={optionId(props.id, open, choice)}
          id={optionId(props.id, open, choice)}
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- See the combobox pattern above.
          role="option"
          aria-selected={index === open.active}
          className={cn(
            "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-sm",
            index === open.active && "bg-accent text-accent-foreground",
          )}
          onMouseDown={keepComposerFocus}
          onClick={() => props.onChoose(choice)}
        >
          {open.source.render(choice)}
        </div>
      ))}
    </div>
  )
}

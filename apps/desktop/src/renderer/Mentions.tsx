import { useAtomValue } from "@effect/atom-react"
import { mapMentions, replaceMentions, type ToDo, toDoMention } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type Editor } from "@tiptap/react"
import { ListTodo } from "lucide-react"
import { Fragment } from "react"
import { ToDoMention } from "./composerDocument"
import { type Range, usePicker } from "./composerPicker"
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

const insertMention = (editor: Editor, { from, to }: Range, { id, title }: ToDo) => {
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
  const openToDos = Option.getOrElse(AsyncResult.value(useAtomValue(openToDosAtom)), () => [])

  return usePicker<ToDo>(
    editor,
    enabled
      ? {
          label: "To-dos",
          typed: ({ before }) => TRIGGER.exec(before)?.[1],
          choices: (typed) => openToDos.filter(({ title }) => title.toLowerCase().includes(typed)),
          key: ({ id }) => String(id),
          insert: insertMention,
          render: ({ title }) => (
            <>
              <ListTodo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{title}</span>
            </>
          ),
        }
      : null,
  )
}

import { useAtomValue } from "@effect/atom-react"
import { mapMentions, type Mentioned, mentionLink, replaceMentions } from "@glass/contracts"
import { Option } from "effect"
import { AsyncResult } from "effect/reactivity"
import { type Editor } from "@tiptap/react"
import { FileText, ListTodo } from "lucide-react"
import { Fragment } from "react"
import { Mention } from "./composerDocument"
import { MAX_CHOICES, type Range, usePicker } from "./composerPicker"
import { fileName } from "./fileName"
import { MentionChip, mentionLabel } from "./MentionChip"
import { openToDosAtom } from "./toDoList"

export const readableText = (message: string) => replaceMentions(message, mentionLabel)

export function MessageText(props: { text: string }) {
  return mapMentions(props.text, {
    text: (text, key) => <Fragment key={key}>{text}</Fragment>,
    mention: (mentioned, key) => <MentionChip key={key} mentioned={mentioned} />,
  })
}

const TRIGGER = /(?:^|\s)@([^\s@[\]()]*)$/

const folderOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0))

const matchingFiles = (files: ReadonlyArray<string>, typed: string, wanted: number) => {
  const byName: Array<Mentioned> = []
  const byFolder: Array<Mentioned> = []

  for (const path of files) {
    if (byName.length === wanted) break

    const lower = path.toLowerCase()

    if (fileName(lower).includes(typed)) byName.push({ kind: "file", path })
    else if (byFolder.length < wanted && lower.includes(typed))
      byFolder.push({ kind: "file", path })
  }

  return [...byName, ...byFolder].slice(0, wanted)
}

const insertMention = (editor: Editor, { from, to }: Range, mentioned: Mentioned) => {
  const after = editor.state.doc.resolve(to).nodeAfter
  const spaced = after?.isText === true && /^\s/.test(after.text ?? "")

  editor
    .chain()
    .focus()
    .insertContentAt({ from, to }, [
      { type: Mention.name, attrs: { link: mentionLink(mentioned) } },
      ...(spaced ? [] : [{ type: "text", text: " " }]),
    ])
    .setTextSelection(from + 2)
    .run()
}

export function useMentionPicker(editor: Editor, enabled: boolean, files: ReadonlyArray<string>) {
  const openToDos = Option.getOrElse(AsyncResult.value(useAtomValue(openToDosAtom)), () => [])

  return usePicker<Mentioned>(
    editor,
    enabled
      ? {
          label: "Mentions",
          typed: ({ before }) => TRIGGER.exec(before)?.[1],
          choices: (typed) => {
            const toDos = openToDos
              .filter(({ title }) => title.toLowerCase().includes(typed))
              .map(({ id, title }): Mentioned => ({ kind: "toDo", id, title }))

            return toDos.length >= MAX_CHOICES
              ? toDos
              : [...toDos, ...matchingFiles(files, typed, MAX_CHOICES - toDos.length)]
          },
          key: mentionLink,
          insert: insertMention,
          render: (mentioned) =>
            mentioned.kind === "toDo" ? (
              <>
                <ListTodo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{mentioned.title}</span>
              </>
            ) : (
              <>
                <FileText aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="shrink-0">{fileName(mentioned.path)}</span>
                <span className="truncate text-muted-foreground">{folderOf(mentioned.path)}</span>
              </>
            ),
        }
      : null,
  )
}

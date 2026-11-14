import { type AgentCommand } from "@glass/contracts"
import { Extension } from "@tiptap/core"
import { type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { type Editor } from "@tiptap/react"
import { useLayoutEffect, useMemo } from "react"
import { CHIP } from "./composerDocument"
import { type Caret, usePicker } from "./composerPicker"

const TYPING = /\/(\S*)$/

const messageStart = (doc: ProseMirrorNode) => {
  let at = 0

  for (const block of doc.children) {
    const text = block.textBetween(0, block.content.size, undefined, CHIP)
    const blank = /^\s*/.exec(text)?.[0].length ?? 0

    if (blank < text.length) return { text: text.slice(blank), from: at + 1 + blank }

    at += block.nodeSize
  }

  return null
}

export const leadingCommand = (doc: ProseMirrorNode, names: Pick<ReadonlySet<string>, "has">) => {
  const start = messageStart(doc)
  const name = start === null ? undefined : /^\/(\S+)/.exec(start.text)?.[1]

  return start !== null && name !== undefined && names.has(name)
    ? { name, from: start.from, to: start.from + 1 + name.length }
    : null
}

const typedCommand = ({ before, at }: Caret, doc: ProseMirrorNode) => {
  const typed = TYPING.exec(before)?.[1]

  return typed !== undefined && messageStart(doc)?.from === at - typed.length - 1
    ? typed
    : undefined
}

type Descriptions = ReadonlyMap<string, string>

const key = new PluginKey<Descriptions>("commandHighlight")

const highlighted = (doc: ProseMirrorNode, descriptions: Descriptions) => {
  const leading = leadingCommand(doc, descriptions)

  return leading === null
    ? DecorationSet.empty
    : DecorationSet.create(doc, [
        Decoration.inline(leading.from, leading.to, {
          class:
            "font-medium text-command before:mr-[0.2em] before:inline-block before:size-[0.9em] before:bg-current before:align-[-0.1em] before:content-[''] before:mask-(--command-icon) before:mask-contain before:mask-center before:mask-no-repeat",
          spellcheck: "false",
          title: descriptions.get(leading.name) ?? "",
        }),
      ])
}

export const CommandHighlight = Extension.create({
  name: "commandHighlight",

  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (): Descriptions => new Map(),
        apply: (transaction, descriptions): Descriptions =>
          transaction.getMeta(key) ?? descriptions,
      },
      props: {
        decorations: (state) => highlighted(state.doc, key.getState(state) ?? new Map()),
      },
    }),
  ],
})

export function useCommandPicker(editor: Editor, commands: ReadonlyArray<AgentCommand>) {
  const descriptions = useMemo(
    () => new Map(commands.map(({ name, description }) => [name, description])),
    [commands],
  )

  useLayoutEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(key, descriptions).setMeta("addToHistory", false))
  }, [editor, descriptions])

  return usePicker<AgentCommand>(
    editor,
    commands.length === 0
      ? null
      : {
          label: "Commands",
          typed: typedCommand,
          choices: (typed) => commands.filter(({ name }) => name.toLowerCase().includes(typed)),
          key: ({ name }) => name,
          insert: (target, range, { name }) =>
            target.chain().focus().insertContentAt(range, `/${name} `).run(),
          render: ({ name, description }) => (
            <>
              <span className="shrink-0 font-mono">/{name}</span>
              <span className="truncate text-muted-foreground">{description}</span>
            </>
          ),
        },
  )
}

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

export const leadingCommand = (doc: ProseMirrorNode, names: ReadonlySet<string>) => {
  const start = messageStart(doc)
  const name = start === null ? undefined : /^\/(\S+)/.exec(start.text)?.[1]

  return start !== null && name !== undefined && names.has(name)
    ? { from: start.from, to: start.from + 1 + name.length }
    : null
}

const typedCommand = ({ before, at }: Caret, doc: ProseMirrorNode) => {
  const typed = TYPING.exec(before)?.[1]

  return typed !== undefined && messageStart(doc)?.from === at - typed.length - 1
    ? typed
    : undefined
}

const key = new PluginKey<ReadonlySet<string>>("commandHighlight")

const highlighted = (doc: ProseMirrorNode, names: ReadonlySet<string>) => {
  const leading = leadingCommand(doc, names)

  return leading === null
    ? DecorationSet.empty
    : DecorationSet.create(doc, [
        Decoration.inline(leading.from, leading.to, {
          class: "rounded-sm bg-primary/15 font-medium text-primary",
        }),
      ])
}

export const CommandHighlight = Extension.create({
  name: "commandHighlight",

  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: () => new Set<string>(),
        apply: (transaction, names): ReadonlySet<string> => transaction.getMeta(key) ?? names,
      },
      props: {
        decorations: (state) => highlighted(state.doc, key.getState(state) ?? new Set()),
      },
    }),
  ],
})

export function useCommandPicker(editor: Editor, commands: ReadonlyArray<AgentCommand>) {
  const names = useMemo(() => new Set(commands.map(({ name }) => name)), [commands])

  useLayoutEffect(() => {
    editor.view.dispatch(editor.state.tr.setMeta(key, names).setMeta("addToHistory", false))
  }, [editor, names])

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

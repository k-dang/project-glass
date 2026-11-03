import { Extension } from "@tiptap/core"
import { type Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { Lexer, type Token } from "marked"
import { chipText } from "./composerDocument"

const MARKER = "text-muted-foreground"

const SPANS = new Map([
  ["strong", "font-semibold"],
  ["em", "italic"],
  ["del", "line-through"],
  ["codespan", "rounded-sm bg-muted font-mono text-[0.9em]"],
  ["code", "font-mono text-[0.9em]"],
  ["heading", "font-semibold"],
  ["blockquote", "text-muted-foreground"],
])

const WRAPPED = new Set(["strong", "em", "del"])

interface Span {
  readonly from: number
  readonly to: number
  readonly className: string
}

const childrenOf = (token: Token): ReadonlyArray<Token> =>
  "items" in token && Array.isArray(token.items)
    ? token.items
    : "tokens" in token && Array.isArray(token.tokens)
      ? token.tokens
      : []

const spansOf = (token: Token, start: number): ReadonlyArray<Span> => {
  const end = start + token.raw.length
  const style = SPANS.get(token.type)
  const spans: Array<Span> = style === undefined ? [] : [{ from: start, to: end, className: style }]
  const children = childrenOf(token)
  const inner = children.map(({ raw }) => raw).join("")
  const at = inner === "" ? -1 : token.raw.indexOf(inner)

  if (WRAPPED.has(token.type) && at > 0) {
    spans.push(
      { from: start, to: start + at, className: MARKER },
      { from: start + at + inner.length, to: end, className: MARKER },
    )
  } else if (token.type === "codespan") {
    const ticks = /^`+/.exec(token.raw)?.[0].length ?? 0
    spans.push(
      { from: start, to: start + ticks, className: MARKER },
      { from: end - ticks, to: end, className: MARKER },
    )
  } else if (token.type === "heading") {
    const prefix = /^#{1,6}[ \t]*/.exec(token.raw)?.[0].length ?? 0
    spans.push({ from: start, to: start + prefix, className: MARKER })
  } else if (token.type === "code" && /^[ \t]*(`{3,}|~{3,})/.test(token.raw)) {
    const body = token.raw.trimEnd()
    const opening = body.indexOf("\n")
    spans.push({
      from: start,
      to: start + (opening < 0 ? body.length : opening),
      className: MARKER,
    })

    if (opening >= 0)
      spans.push({
        from: start + body.lastIndexOf("\n") + 1,
        to: start + body.length,
        className: MARKER,
      })
  }

  if (at < 0) return spans

  let offset = start + at

  for (const child of children) {
    spans.push(...spansOf(child, offset))
    offset += child.raw.length
  }

  return spans
}

export const markdownSpans = (doc: ProseMirrorNode): ReadonlyArray<Span> => {
  const text = chipText(doc)
  const breaks = Array.from(text.matchAll(/\n/g), ({ index }) => index)
  const position = (at: number) => at + 1 + breaks.filter((index) => index < at).length

  const spans: Array<Span> = []
  let start = 0

  for (const token of Lexer.lex(text, { gfm: true })) {
    for (const { from, to, className } of spansOf(token, start)) {
      const span = { from: position(from), to: position(to), className }

      if (span.to > span.from) spans.push(span)
    }

    start += token.raw.length
  }

  return spans
}

const decorate = (doc: ProseMirrorNode) =>
  DecorationSet.create(
    doc,
    markdownSpans(doc).map(({ from, to, className }) =>
      Decoration.inline(from, to, { class: className }),
    ),
  )

const key = new PluginKey<DecorationSet>("markdownStyling")

export const MarkdownStyling = Extension.create({
  name: "markdownStyling",

  addProseMirrorPlugins: () => [
    new Plugin({
      key,
      state: {
        init: (_config, state) => decorate(state.doc),
        apply: (transaction, decorations) =>
          transaction.docChanged ? decorate(transaction.doc) : decorations,
      },
      props: { decorations: (state) => key.getState(state) },
    }),
  ],
})

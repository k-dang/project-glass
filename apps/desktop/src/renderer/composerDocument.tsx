import { mapMentions } from "@glass/contracts"
import { type JSONContent, Node } from "@tiptap/core"
import { type Fragment, type Node as ProseMirrorNode, type Schema, Slice } from "@tiptap/pm/model"
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { MentionChip } from "./MentionChip"

export const CHIP = "￼"

export const ToDoMention = Node.create({
  name: "toDoMention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes: () => ({
    title: { default: "" },
    link: { default: "" },
  }),

  renderHTML: ({ node, HTMLAttributes }) => ["span", HTMLAttributes, node.attrs.title],

  addNodeView: () => ReactNodeViewRenderer(ToDoMentionView, { as: "span" }),
})

function ToDoMentionView({ node }: ReactNodeViewProps) {
  return (
    <NodeViewWrapper as="span">
      <MentionChip title={node.attrs.title} className="bg-muted" />
    </NodeViewWrapper>
  )
}

export const toContent = (message: string): JSONContent => ({
  type: "doc",
  content: message.split("\n").map((line) => {
    const content = mapMentions<JSONContent>(line, {
      text: (text) => ({ type: "text", text }),
      mention: ({ title }, _key, link) => ({ type: ToDoMention.name, attrs: { title, link } }),
    })

    return content.length === 0
      ? { type: "paragraph" }
      : { type: "paragraph", content: [...content] }
  }),
})

export const toMessage = (content: Fragment) =>
  content.textBetween(0, content.size, "\n", (chip) => chip.attrs.link)

export const chipText = (doc: ProseMirrorNode) => doc.textBetween(0, doc.content.size, "\n", CHIP)

export const pastedSlice = (schema: Schema, text: string) =>
  new Slice(schema.nodeFromJSON(toContent(text.replaceAll(/\r\n?/g, "\n"))).content, 1, 1)

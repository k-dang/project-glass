import { mapMentions, mentionsIn } from "@glass/contracts"
import { type JSONContent, Node } from "@tiptap/core"
import { type Fragment, type Node as ProseMirrorNode, type Schema, Slice } from "@tiptap/pm/model"
import { NodeViewWrapper, ReactNodeViewRenderer, type ReactNodeViewProps } from "@tiptap/react"
import { MentionChip, mentionLabel } from "./MentionChip"

export const CHIP = "￼"

export const Mention = Node.create({
  name: "mention",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes: () => ({
    link: { default: "" },
  }),

  renderHTML: ({ node, HTMLAttributes }) => {
    const mentioned = mentionsIn(node.attrs.link)[0]

    return ["span", HTMLAttributes, mentioned === undefined ? "" : mentionLabel(mentioned)]
  },

  addNodeView: () => ReactNodeViewRenderer(MentionView, { as: "span" }),
})

function MentionView({ node }: ReactNodeViewProps) {
  const mentioned = mentionsIn(node.attrs.link)[0]

  return (
    <NodeViewWrapper as="span">
      {mentioned !== undefined && <MentionChip mentioned={mentioned} className="bg-muted" />}
    </NodeViewWrapper>
  )
}

export const toContent = (message: string): JSONContent => ({
  type: "doc",
  content: message.split("\n").map((line) => {
    const content = mapMentions<JSONContent>(line, {
      text: (text) => ({ type: "text", text }),
      mention: (_mentioned, _key, link) => ({ type: Mention.name, attrs: { link } }),
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

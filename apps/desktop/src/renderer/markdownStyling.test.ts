import { toDoMention } from "@glass/contracts"
import { getSchema } from "@tiptap/core"
import { Document } from "@tiptap/extension-document"
import { Paragraph } from "@tiptap/extension-paragraph"
import { Text } from "@tiptap/extension-text"
import { expect, it } from "vite-plus/test"
import { CHIP, toContent, Mention } from "./composerDocument"
import { markdownSpans } from "./markdownStyling"

const schema = getSchema([Document, Paragraph, Text, Mention])

const docOf = (message: string) => schema.nodeFromJSON(toContent(message))

const mention = toDoMention({ id: 3, title: "Fix the flaky test" })

it("styles Markdown where it is written, across lines and after chips", () => {
  const doc = docOf(`${mention} says **hi**\n\`run_it\` now`)

  expect(
    markdownSpans(doc).map(({ from, to, className }) => [
      doc.textBetween(from, to, "\n", CHIP),
      className,
    ]),
  ).toEqual([
    ["**hi**", "font-semibold"],
    ["**", "text-muted-foreground"],
    ["**", "text-muted-foreground"],
    ["`run_it`", "rounded-sm bg-muted font-mono text-[0.9em]"],
    ["`", "text-muted-foreground"],
    ["`", "text-muted-foreground"],
  ])
})

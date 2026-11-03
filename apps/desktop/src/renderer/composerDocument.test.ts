import { toDoMention } from "@glass/contracts"
import { getSchema } from "@tiptap/core"
import { Document } from "@tiptap/extension-document"
import { Paragraph } from "@tiptap/extension-paragraph"
import { Text } from "@tiptap/extension-text"
import { expect, it } from "vite-plus/test"
import { toContent, ToDoMention, toMessage } from "./composerDocument"

const schema = getSchema([Document, Paragraph, Text, ToDoMention])

it("turns a message into chips and lines and back without changing a character", () => {
  const message = `Rename \`foo_bar\` in **<App>**\n\n${toDoMention({ id: 3, title: "Fix the flaky test" })} \\*then\\* &amp; [Fix  spacing](glass://to-do/0003)`

  expect(toMessage(schema.nodeFromJSON(toContent(message)).content)).toBe(message)
})

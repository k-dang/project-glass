import { getSchema } from "@tiptap/core"
import { Document } from "@tiptap/extension-document"
import { Paragraph } from "@tiptap/extension-paragraph"
import { Text } from "@tiptap/extension-text"
import { expect, it } from "vite-plus/test"
import { leadingCommand } from "./Commands"
import { toContent, ToDoMention } from "./composerDocument"

const schema = getSchema([Document, Paragraph, Text, ToDoMention])

const shown = (message: string) => {
  const doc = schema.nodeFromJSON(toContent(message))
  const span = leadingCommand(doc, new Set(["greet", "skill:pdf"]))

  return span === null ? null : doc.textBetween(span.from, span.to)
}

it("shows a command only where the message starts with one the program offers", () => {
  expect(shown("/greet Ada")).toBe("/greet")
  expect(shown("/skill:pdf report.pdf")).toBe("/skill:pdf")
  // Glass sends the message trimmed.
  expect(shown("\n  /greet")).toBe("/greet")
  expect(shown("/greeter")).toBeNull()
  expect(shown("Say /greet")).toBeNull()
  expect(shown("Hi\n/greet")).toBeNull()
})

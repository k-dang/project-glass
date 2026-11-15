import { ToDo } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import { linkLabel, newestFirst, noteParts } from "./toDoOrder"

const item = (id: number, title: string, notes = "") => new ToDo({ id, title, notes, done: false })

it("lists open to-dos newest id first", () => {
  expect(newestFirst([item(1, "a"), item(3, "c"), item(2, "b")]).map((toDo) => toDo.id)).toEqual([
    3, 2, 1,
  ])
})

it("splits notes into text and links, and shortens a long link", () => {
  expect(noteParts("See https://capy.ai/ before deciding.")).toEqual([
    { kind: "text", value: "See " },
    { kind: "link", value: "https://capy.ai/" },
    { kind: "text", value: " before deciding." },
  ])
  expect(noteParts("https://example.com/docs).")).toEqual([
    { kind: "link", value: "https://example.com/docs" },
    { kind: "text", value: ")." },
  ])
  expect(linkLabel("https://capy.ai/")).toBe("capy.ai")
  expect(linkLabel("https://ui.shadcn.com/blocks/sidebar#sidebar-08")).toBe(
    "ui.shadcn.com/blocks/sidebar#sidebar-08",
  )
  expect(
    linkLabel(
      "https://bennettaur.github.io/yarvis/artifacts-beside-the-chat/02-diagram-beside-the-chat.png",
    ),
  ).toBe("bennettaur.github.io/…/02-diagram-beside-the-chat.png")
})

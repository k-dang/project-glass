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
  expect(noteParts("See https://example.com/ before deciding.")).toEqual([
    { kind: "text", value: "See " },
    { kind: "link", value: "https://example.com/" },
    { kind: "text", value: " before deciding." },
  ])
  expect(noteParts("https://example.com/docs).")).toEqual([
    { kind: "link", value: "https://example.com/docs" },
    { kind: "text", value: ")." },
  ])
  expect(linkLabel("https://example.com/")).toBe("example.com")
  expect(linkLabel("https://example.com/docs#setup")).toBe("example.com/docs#setup")
  expect(
    linkLabel(
      "https://example.com/docs/guides/getting-started/installation/screenshots/diagram.png",
    ),
  ).toBe("example.com/…/diagram.png")
})

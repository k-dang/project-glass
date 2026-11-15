import { ToDo } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import {
  checklistToDos,
  linkLabel,
  moveBefore,
  moveBy,
  newestFirst,
  noteParts,
  notedToDos,
  orderedBy,
  reconcileOrder,
} from "./toDoOrder"

const item = (id: number, title: string, notes = "") => new ToDo({ id, title, notes, done: false })

it("lists open to-dos newest id first", () => {
  expect(newestFirst([item(1, "a"), item(3, "c"), item(2, "b")]).map((toDo) => toDo.id)).toEqual([
    3, 2, 1,
  ])
})

it("keeps a manual order and appends to-dos it has not placed", () => {
  const open = [item(1, "a"), item(2, "b"), item(4, "d")]

  expect(reconcileOrder(open, [4, 9, 1, 4])).toEqual([4, 1, 2])
  expect(orderedBy(open, [4, 1]).map((toDo) => toDo.title)).toEqual(["d", "a", "b"])
})

it("moves a to-do before another, or to the end", () => {
  expect(moveBefore([1, 2, 3, 4], 2, 4)).toEqual([1, 3, 2, 4])
  expect(moveBefore([1, 2, 3], 1, null)).toEqual([2, 3, 1])
  expect(moveBefore([1, 2, 3], 2, 2)).toEqual([1, 2, 3])
  expect(moveBy([1, 2, 3], 1, 1)).toEqual([2, 1, 3])
  expect(moveBy([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
  expect(moveBy([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
  expect(moveBy([1, 2, 3], 3, 1)).toEqual([1, 2, 3])
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

it("keeps title-only to-dos in added order and notes newest first", () => {
  const open = [
    item(1, "linked", "https://capy.ai/"),
    item(2, "plain"),
    item(3, "later", "A long note"),
    item(4, "other"),
  ]

  expect(checklistToDos(open).map((toDo) => toDo.id)).toEqual([2, 4])
  expect(notedToDos(open).map((toDo) => toDo.id)).toEqual([3, 1])
})

import { FeedbackNote, TextPatch } from "@glass/contracts"
import { describe, expect, it } from "vite-plus/test"
import { layOut } from "./changesView"
import {
  type FeedbackExtra,
  feedbackAnnotations,
  feedbackTarget,
  nextSelection,
} from "./feedbackLines"
import { changedFile } from "../../test/workspace"

const [parsed] = layOut([
  changedFile(
    "greet.ts",
    TextPatch.make({
      hunks: [
        "@@ -1,4 +1,4 @@",
        " const name = 'you'",
        "-const greeting = 'hi'",
        "+const greeting = 'hello'",
        " greet(name)",
        " done()",
        "@@ -10,2 +10,3 @@",
        " later()",
        "+added()",
        " end()",
      ].join("\n"),
    }),
  ),
]).files

const fileDiff = parsed!.fileDiff

describe("feedbackTarget", () => {
  it("keeps the code of a range on the new side, as the user read it", () => {
    expect(feedbackTarget(fileDiff, { start: 2, side: "additions", end: 3 })).toEqual({
      side: "new",
      start: 2,
      end: 3,
      code: "const greeting = 'hello'\ngreet(name)",
    })
  })

  it("keeps the code of a line on the old side, in either selection direction", () => {
    expect(feedbackTarget(fileDiff, { start: 2, side: "deletions", end: 1 })).toEqual({
      side: "old",
      start: 1,
      end: 2,
      code: "const name = 'you'\nconst greeting = 'hi'",
    })
  })

  it("refuses ranges across both sides or over lines the diff doesn't show", () => {
    expect(
      feedbackTarget(fileDiff, { start: 2, side: "deletions", end: 2, endSide: "additions" }),
    ).toBeNull()
    expect(feedbackTarget(fileDiff, { start: 4, side: "additions", end: 10 })).toBeNull()
    expect(feedbackTarget(fileDiff, { start: 10, side: "additions", end: 12 })).toEqual({
      side: "new",
      start: 10,
      end: 12,
      code: "later()\nadded()\nend()",
    })
  })
})

const note = (id: string, changesId: string, side: "old" | "new", end: number) =>
  new FeedbackNote({
    id,
    path: "greet.ts",
    side,
    start: 1,
    end,
    code: "code",
    changesId,
    text: "Change it",
  })

describe("feedbackAnnotations", () => {
  const notes = [note("old-side", "read-2", "old", 2), note("older", "read-1", "new", 3)]

  const annotations = (path: string, extra: FeedbackExtra | null) =>
    feedbackAnnotations(notes, "read-2", extra)(path).annotations

  it("places notes from the displayed Changes under the last line of their range", () => {
    expect(annotations("greet.ts", null)).toEqual([
      { side: "deletions", lineNumber: 2, metadata: { type: "note", id: "old-side" } },
    ])
    expect(annotations("other.ts", null)).toEqual([])
  })

  it("shows the editor in place of the note being edited, and a new one or a selection under its range", () => {
    expect(
      annotations("greet.ts", {
        type: "editor",
        id: "old-side",
        path: "greet.ts",
        side: "old",
        end: 2,
      }),
    ).toEqual([{ side: "deletions", lineNumber: 2, metadata: { type: "editor" } }])
    expect(
      annotations("greet.ts", {
        type: "editor",
        id: "new-note",
        path: "greet.ts",
        side: "new",
        end: 4,
      }),
    ).toEqual([
      { side: "deletions", lineNumber: 2, metadata: { type: "note", id: "old-side" } },
      { side: "additions", lineNumber: 4, metadata: { type: "editor" } },
    ])
    expect(
      annotations("greet.ts", { type: "selection", path: "greet.ts", side: "new", end: 3 }),
    ).toContainEqual({ side: "additions", lineNumber: 3, metadata: { type: "selection" } })
  })
})

describe("nextSelection", () => {
  it("extends a range line by line within one side, across hunks, and stops at the last line", () => {
    const range = { start: 3, side: "additions", end: 3 } as const

    expect(nextSelection(fileDiff, range, 1)).toEqual({ ...range, end: 4, endSide: "additions" })
    expect(nextSelection(fileDiff, { ...range, end: 4 }, 1)).toEqual({
      ...range,
      end: 10,
      endSide: "additions",
    })
    expect(nextSelection(fileDiff, { ...range, end: 12 }, 1)).toBeNull()
    expect(nextSelection(fileDiff, { start: 2, side: "deletions", end: 2 }, -1)).toEqual({
      start: 2,
      side: "deletions",
      end: 1,
      endSide: "deletions",
    })
  })
})

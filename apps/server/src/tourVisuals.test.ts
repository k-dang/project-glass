import { ChangedFile, type Chapter, TextPatch, type TourBeforeAfter } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import {
  repairChapterVisuals,
  validateTourBeforeAfter,
  validateTourDiagram,
  repairTourVisuals,
} from "./tourVisuals"

const file = new ChangedFile({
  path: "handler.ts",
  previousPath: null,
  changeType: "modified",
  additions: 2,
  deletions: 1,
  patch: TextPatch.make({
    hunks: "@@ -1,2 +1,3 @@\n receive\n-write\n+validate\n+write\n@@ -10 +11 @@\n context",
  }),
})

const diagram = [
  "flowchart LR",
  "  receive[Receive request] --> validate[Validate before writing]:::added",
  "  validate --> write[Write]",
  "  receive -.-> write",
].join("\n")

const undrawable = "flowchart LR\n  A -->> [["

const chapter: Chapter = {
  title: "Validate input",
  explanation: "Validation happens before storage.",
  files: [{ path: file.path, summary: "Validates the request." }],
  diagram,
}

it("keeps a flowchart Pele can draw and omits anything else", () => {
  expect(validateTourDiagram(diagram)).toEqual(diagram)
  expect(validateTourDiagram(undrawable)).toBeNull()
  expect(validateTourDiagram("sequenceDiagram\n  A->>B: hi")).toBeNull()
})

const beforeAfter: TourBeforeAfter = {
  title: "How a request is stored",
  lines: [
    { depth: 0, text: "Receive request", change: "unchanged", target: null },
    {
      depth: 1,
      text: "Write straight away",
      change: "removed",
      target: { path: file.path, side: "old", startLine: 2, endLine: 2 },
    },
    {
      depth: 1,
      text: "Validate, then write",
      change: "added",
      target: { path: file.path, side: "new", startLine: 2, endLine: 3 },
    },
  ],
}

it("keeps a Before / after whose changed lines are anchored to the diff", () => {
  expect(validateTourBeforeAfter(beforeAfter, [file])).toEqual(beforeAfter)
})

it("keeps one overview map, retaining the outline when the diagram cannot be drawn", () => {
  expect(repairTourVisuals({ diagram, beforeAfter }, [file])).toEqual({
    diagram,
    beforeAfter: null,
  })
  expect(repairTourVisuals({ diagram: undrawable, beforeAfter }, [file])).toEqual({
    diagram: null,
    beforeAfter,
  })
})

it("drops the reference from an unchanged line outside the diff, keeping the line", () => {
  const outside = { path: file.path, side: "new", startLine: 500, endLine: 500 } as const
  const [first, ...rest] = beforeAfter.lines

  expect(
    validateTourBeforeAfter({ ...beforeAfter, lines: [{ ...first!, target: outside }, ...rest] }, [
      file,
    ]),
  ).toEqual(beforeAfter)
})

it.each([
  ["no target", null],
  ["a line outside the diff", { path: file.path, side: "new", startLine: 500, endLine: 500 }],
  ["the wrong side", { path: file.path, side: "old", startLine: 2, endLine: 2 }],
] as const)("omits a Before / after with an added line on %s", (_, target) => {
  const lines = beforeAfter.lines.map((line) =>
    line.change === "added" ? { ...line, target } : line,
  )

  expect(validateTourBeforeAfter({ ...beforeAfter, lines }, [file])).toBeNull()
})

it("omits a Before / after that changes nothing or targets another file", () => {
  const lines = beforeAfter.lines.map((line) => ({ ...line, change: "unchanged" as const }))

  expect(validateTourBeforeAfter({ ...beforeAfter, lines }, [file])).toBeNull()
  expect(validateTourBeforeAfter(beforeAfter, [])).toBeNull()
})

it("keeps one map per Chapter, preferring the diagram over a Before / after", () => {
  expect(repairChapterVisuals({ ...chapter, beforeAfter }, [file])).toMatchObject({
    diagram,
    beforeAfter: null,
  })
  expect(
    repairChapterVisuals({ ...chapter, diagram: undrawable, beforeAfter }, [file]),
  ).toMatchObject({ diagram: null, beforeAfter })
})

it("keeps callouts anchored to the Chapter diff and drops invalid targets", () => {
  const callout = {
    label: "Validation comes before the write.",
    target: { path: file.path, side: "new", startLine: 2, endLine: 3 },
  } as const

  const elsewhere = new ChangedFile({
    path: "other.ts",
    previousPath: null,
    changeType: "modified",
    additions: file.additions,
    deletions: file.deletions,
    patch: file.patch,
  })

  const callouts = [
    callout,
    { ...callout, target: { ...callout.target, startLine: 99, endLine: 99 } },
    { ...callout, target: { ...callout.target, path: elsewhere.path } },
  ]

  expect(
    repairChapterVisuals({ ...chapter, diagram: null, callouts }, [file, elsewhere]).callouts,
  ).toEqual([callout])
})

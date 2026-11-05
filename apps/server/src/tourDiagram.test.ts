import {
  BinaryFile,
  ChangedFile,
  type Chapter,
  TextPatch,
  type TourBeforeAfter,
  type TourDiagram,
} from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import {
  repairChapterVisuals,
  validateTourBeforeAfter,
  validateTourDiagram,
  validateTourCallouts,
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

const diagram: TourDiagram = {
  nodes: [
    {
      id: "receive",
      label: "Receive request",
      change: "unchanged",
      target: { path: file.path, side: "new", startLine: 1, endLine: 1 },
    },
    {
      id: "validate",
      label: "Validate before writing",
      change: "added",
      target: { path: file.path, side: "new", startLine: 2, endLine: 3 },
    },
  ],
  edges: [{ from: "receive", to: "validate", change: "added" }],
}

const chapter: Chapter = {
  title: "Validate input",
  explanation: "Validation happens before storage.",
  files: [{ path: file.path, summary: "Validates the request." }],
  diagram,
}

it("validates flow references and preserves a static diagram when its steps are unusable", () => {
  const steps = [
    { caption: "Receive input", nodes: ["receive"], edges: [], stateChanges: [] },
    {
      caption: "Validate input",
      nodes: ["validate"],
      edges: [0],
      stateChanges: [{ label: "Input", before: "unchecked", after: "valid" }],
    },
  ]

  expect(validateTourDiagram({ ...diagram, steps }, [file])?.steps).toEqual(steps)
  expect(
    validateTourDiagram({ ...diagram, steps: [{ ...steps[0]!, nodes: ["invented"] }, steps[1]!] }, [
      file,
    ]),
  ).toEqual(diagram)
  expect(
    validateTourDiagram({ ...diagram, steps: [steps[0]!, { ...steps[1]!, edges: [9] }] }, [file]),
  ).toEqual(diagram)
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
    repairChapterVisuals({ ...chapter, diagram: { ...diagram, edges: [] }, beforeAfter }, [file]),
  ).toMatchObject({ diagram: null, beforeAfter })
})

it("keeps callouts anchored to the Chapter diff and drops invalid targets", () => {
  const callout = { label: "Validation comes before the write.", target: diagram.nodes[1]!.target }
  expect(
    validateTourCallouts(
      [callout, { ...callout, target: { ...callout.target, startLine: 99, endLine: 99 } }],
      [file],
    ),
  ).toEqual([callout])
})

it("accepts connected diagrams anchored to complete patch ranges on either side", () => {
  expect(validateTourDiagram(diagram, [file])).toEqual(diagram)

  const removed: TourDiagram = {
    ...diagram,
    nodes: [
      diagram.nodes[0]!,
      {
        ...diagram.nodes[1]!,
        change: "removed",
        target: { path: file.path, side: "old", startLine: 2, endLine: 2 },
      },
    ],
  }

  expect(validateTourDiagram(removed, [file])).toEqual(removed)
})

it.each([
  ["invented path", { path: "invented.ts", side: "new", startLine: 2, endLine: 2 }],
  ["line outside patch", { path: file.path, side: "new", startLine: 4, endLine: 4 }],
  ["range crossing a gap", { path: file.path, side: "new", startLine: 3, endLine: 11 }],
  ["reversed range", { path: file.path, side: "new", startLine: 3, endLine: 2 }],
  ["added node on old side", { path: file.path, side: "old", startLine: 2, endLine: 2 }],
] as const)("omits a diagram with an invalid target: %s", (_, target) => {
  expect(
    validateTourDiagram(
      { ...diagram, nodes: [diagram.nodes[0]!, { ...diagram.nodes[1]!, target }] },
      [file],
    ),
  ).toBeNull()
})

it("rejects targets outside the Chapter and files without a text patch", () => {
  expect(repairChapterVisuals({ ...chapter, files: [] }, [file]).diagram).toBeNull()
  expect(
    validateTourDiagram(diagram, [
      new ChangedFile({
        path: file.path,
        previousPath: null,
        changeType: "modified",
        additions: 0,
        deletions: 0,
        patch: BinaryFile.make({}),
      }),
    ]),
  ).toBeNull()
})

it.each([
  ["missing node", [{ from: "receive", to: "missing", change: "added" }]],
  ["self connection", [diagram.edges[0]!, { from: "receive", to: "receive", change: "added" }]],
  ["duplicate connection", [diagram.edges[0]!, diagram.edges[0]!]],
] as const)("rejects an invalid graph: %s", (_, edges) => {
  expect(validateTourDiagram({ ...diagram, edges }, [file])).toBeNull()
})

it("rejects duplicate node ids and disconnected nodes", () => {
  expect(
    validateTourDiagram({ ...diagram, nodes: [...diagram.nodes, diagram.nodes[0]!] }, [file]),
  ).toBeNull()
  expect(
    validateTourDiagram(
      { ...diagram, nodes: [...diagram.nodes, { ...diagram.nodes[0]!, id: "unconnected" }] },
      [file],
    ),
  ).toBeNull()
})

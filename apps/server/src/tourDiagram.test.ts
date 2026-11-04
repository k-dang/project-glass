import {
  BinaryFile,
  ChangedFile,
  type Chapter,
  TextPatch,
  type TourDiagram,
  type TourCallTree,
} from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import {
  repairChapterVisuals,
  validateTourDiagram,
  validateTourCallTree,
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

  expect(validateTourDiagram({ ...diagram, steps }, chapter, [file])?.steps).toEqual(steps)
  expect(
    validateTourDiagram(
      { ...diagram, steps: [{ ...steps[0]!, nodes: ["invented"] }, steps[1]!] },
      chapter,
      [file],
    ),
  ).toEqual(diagram)
  expect(
    validateTourDiagram({ ...diagram, steps: [steps[0]!, { ...steps[1]!, edges: [9] }] }, chapter, [
      file,
    ]),
  ).toEqual(diagram)
})

it("accepts a rooted call tree and rejects unknown callers, cycles, and multiple roots", () => {
  const tree: TourCallTree = [
    { ...diagram.nodes[0]!, parent: null },
    { ...diagram.nodes[1]!, parent: "receive" },
  ]

  expect(validateTourCallTree(tree, chapter, [file])).toEqual(tree)

  for (const parent of ["missing", "validate", null]) {
    expect(validateTourCallTree([tree[0]!, { ...tree[1]!, parent }], chapter, [file])).toBeNull()
  }

  expect(validateTourCallTree([tree[1]!, tree[0]!], chapter, [file])).toBeNull()
})

it("keeps one map per Chapter, preferring the diagram over a call tree", () => {
  const callTree: TourCallTree = [
    { ...diagram.nodes[0]!, parent: null },
    { ...diagram.nodes[1]!, parent: "receive" },
  ]

  expect(repairChapterVisuals({ ...chapter, callTree }, [file])).toMatchObject({
    diagram,
    callTree: null,
  })
  expect(
    repairChapterVisuals({ ...chapter, diagram: { ...diagram, edges: [] }, callTree }, [file]),
  ).toMatchObject({ diagram: null, callTree })
})

it("keeps callouts anchored to the Chapter diff and drops invalid targets", () => {
  const callout = { label: "Validation comes before the write.", target: diagram.nodes[1]!.target }
  expect(
    validateTourCallouts(
      [callout, { ...callout, target: { ...callout.target, startLine: 99, endLine: 99 } }],
      chapter,
      [file],
    ),
  ).toEqual([callout])
})

it("accepts connected diagrams anchored to complete patch ranges on either side", () => {
  expect(validateTourDiagram(diagram, chapter, [file])).toEqual(diagram)

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

  expect(validateTourDiagram(removed, chapter, [file])).toEqual(removed)
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
      chapter,
      [file],
    ),
  ).toBeNull()
})

it("rejects targets outside the Chapter and files without a text patch", () => {
  expect(validateTourDiagram(diagram, { ...chapter, files: [] }, [file])).toBeNull()
  expect(
    validateTourDiagram(diagram, chapter, [
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
  expect(validateTourDiagram({ ...diagram, edges }, chapter, [file])).toBeNull()
})

it("rejects duplicate node ids and disconnected nodes", () => {
  expect(
    validateTourDiagram({ ...diagram, nodes: [...diagram.nodes, diagram.nodes[0]!] }, chapter, [
      file,
    ]),
  ).toBeNull()
  expect(
    validateTourDiagram(
      { ...diagram, nodes: [...diagram.nodes, { ...diagram.nodes[0]!, id: "unconnected" }] },
      chapter,
      [file],
    ),
  ).toBeNull()
})

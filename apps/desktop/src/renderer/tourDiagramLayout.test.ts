import type { TourDiagram } from "@glass/contracts"
import { expect, it } from "vite-plus/test"
import { diagramEdgeText, layOutTourDiagram } from "./tourDiagramLayout"

const target = { path: "flow.ts", side: "new", startLine: 1, endLine: 1 } as const

const nodes = ["start", "left", "right", "merge"].map((id) => ({
  id,
  label: id,
  change: "unchanged" as const,
  target,
}))

const branching: TourDiagram = {
  nodes,
  edges: [
    { from: "start", to: "left", change: "unchanged", label: "existing path" },
    { from: "start", to: "right", change: "added", label: "new path" },
    { from: "left", to: "merge", change: "unchanged" },
    { from: "right", to: "merge", change: "added" },
  ],
}

const draw = (diagram: TourDiagram) =>
  layOutTourDiagram(
    diagram,
    new Map(nodes.map(({ id }) => [id, { width: 184, height: 100 }])),
    diagram.edges.map((edge) => ({ width: diagramEdgeText(edge).length * 7, height: 18 })),
  )

it("places a split and merge on separate ranks with non-overlapping, bounded nodes", () => {
  const drawing = draw(branching)
  const [start, left, right, merge] = drawing.nodes
  expect(start!.top).toBeLessThan(left!.top)
  expect(left!.top).toBe(right!.top)
  expect(left!.top).toBeLessThan(merge!.top)
  expect(Math.abs(left!.left - right!.left)).toBeGreaterThanOrEqual(184)

  for (const node of drawing.nodes) {
    expect(node.left).toBeGreaterThanOrEqual(0)
    expect(node.top).toBeGreaterThanOrEqual(0)
    expect(node.left + 184).toBeLessThanOrEqual(drawing.width)
    expect(node.top + 100).toBeLessThanOrEqual(drawing.height)
  }

  expect(drawing.edges.every((edge) => !edge.path.includes("NaN"))).toBe(true)
  expect(drawing.edges[1]!.text).toBe("+ new path")
})

it("keeps an inserted step horizontal while routing its removed bypass separately", () => {
  const drawing = draw({
    nodes: nodes.slice(0, 3),
    edges: [
      { from: "start", to: "left", change: "added" },
      { from: "left", to: "right", change: "added" },
      { from: "start", to: "right", change: "removed", label: "before" },
    ],
  })

  const [start, middle, end] = drawing.nodes
  expect(start!.left).toBeLessThan(middle!.left)
  expect(middle!.left).toBeLessThan(end!.left)
  expect(drawing.edges[2]!.text).toBe("− before")
})

it("routes a return connection without losing the graph", () => {
  const drawing = draw({
    ...branching,
    edges: [...branching.edges, { from: "merge", to: "start", change: "added", label: "retry" }],
  })

  expect(Number.isFinite(drawing.width)).toBe(true)
  expect(Number.isFinite(drawing.height)).toBe(true)
  expect(drawing.edges).toHaveLength(5)
  expect(
    drawing.edges.every((edge) => edge.path.startsWith("M ") && !edge.path.includes("NaN")),
  ).toBe(true)
})

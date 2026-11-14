import { Graph, layout, type EdgeLabel, type GraphLabel, type NodeLabel } from "@dagrejs/dagre"
import type { TourDiagram } from "@glass/contracts"

export interface DiagramSize {
  readonly width: number
  readonly height: number
}

const signs = { unchanged: "", added: "+", removed: "−" }

export const diagramEdgeText = (edge: TourDiagram["edges"][number]) =>
  [signs[edge.change], edge.label].filter(Boolean).join(" ")

export const layOutTourDiagram = (
  diagram: TourDiagram,
  nodeSizes: ReadonlyMap<string, DiagramSize>,
  edgeSizes: ReadonlyArray<DiagramSize>,
) => {
  const outgoing = new Map<string, number>()
  const incoming = new Map<string, number>()

  for (const edge of diagram.edges) {
    if (edge.change === "removed") continue
    outgoing.set(edge.from, (outgoing.get(edge.from) ?? 0) + 1)
    incoming.set(edge.to, (incoming.get(edge.to) ?? 0) + 1)
  }

  const branching = [...outgoing.values(), ...incoming.values()].some((count) => count > 1)
  const graph = new Graph<GraphLabel, NodeLabel, EdgeLabel>()
  graph.setGraph({
    rankdir: branching ? "TB" : "LR",
    nodesep: 32,
    ranksep: 40,
    edgesep: 18,
    marginx: 12,
    marginy: 12,
  })

  for (const node of diagram.nodes)
    graph.setNode(node.id, { ...(nodeSizes.get(node.id) ?? { width: 184, height: 88 }) })

  diagram.edges.forEach((edge, index) =>
    graph.setEdge(edge.from, edge.to, { ...edgeSizes[index], labelpos: "c" }),
  )

  layout(graph)

  return {
    width: graph.graph().width!,
    height: graph.graph().height!,
    nodes: diagram.nodes.map((node) => {
      const box = graph.node(node.id)

      return { left: box.x! - box.width / 2, top: box.y! - box.height / 2, ...node }
    }),
    edges: diagram.edges.map((edge) => {
      const placed = graph.edge(edge.from, edge.to)

      return {
        path: placed.points!.map(({ x, y }, i) => `${i === 0 ? "M" : "L"} ${x} ${y}`).join(" "),
        x: placed.x,
        y: placed.y,
        text: diagramEdgeText(edge),
        ...edge,
      }
    }),
  }
}

import type {
  ChangedFile,
  Chapter,
  TourCodeTarget,
  TourDiagram,
  TourDiagramNode,
  TourCallTree,
  TourCallouts,
} from "@glass/contracts"
import { Predicate } from "effect"
import { rangeInPatch } from "./github/patchLines"

const validTarget = (
  target: TourCodeTarget,
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
) => {
  const file = files.find((entry) => entry.path === target.path)

  return (
    chapter.files.some((entry) => entry.path === target.path) &&
    file !== undefined &&
    Predicate.isTagged(file.patch, "TextPatch") &&
    rangeInPatch(file.patch.hunks, target.side, target.startLine, target.endLine)
  )
}

const validNode = (node: TourDiagramNode, chapter: Chapter, files: ReadonlyArray<ChangedFile>) =>
  (node.change !== "added" || node.target.side === "new") &&
  (node.change !== "removed" || node.target.side === "old") &&
  validTarget(node.target, chapter, files)

export const validateTourDiagram = (
  diagram: TourDiagram,
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
): TourDiagram | null => {
  const ids = new Set(diagram.nodes.map((node) => node.id))

  if (ids.size !== diagram.nodes.length) return null

  if (!diagram.nodes.every((node) => validNode(node, chapter, files))) return null

  const connections = new Map(diagram.nodes.map((node) => [node.id, new Set<string>()]))
  const edges = new Set<string>()

  for (const edge of diagram.edges) {
    const key = JSON.stringify([edge.from, edge.to])

    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to || edges.has(key))
      return null

    edges.add(key)
    connections.get(edge.from)!.add(edge.to)
    connections.get(edge.to)!.add(edge.from)
  }

  const connected = new Set<string>()
  const pending = [diagram.nodes[0]!.id]

  while (pending.length > 0) {
    const id = pending.pop()!

    if (connected.has(id)) continue

    connected.add(id)
    pending.push(...connections.get(id)!)
  }

  if (connected.size !== ids.size) return null

  if (
    diagram.steps?.some(
      (step) =>
        step.nodes.some((id) => !ids.has(id)) ||
        new Set(step.nodes).size !== step.nodes.length ||
        step.edges.some((index) => index >= diagram.edges.length) ||
        new Set(step.edges).size !== step.edges.length,
    )
  ) {
    const { steps: _steps, ...staticDiagram } = diagram

    return staticDiagram
  }

  return diagram
}

export const validateTourCallTree = (
  tree: TourCallTree,
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
): TourCallTree | null => {
  const seen = new Set<string>()

  for (const node of tree) {
    if (seen.has(node.id) || !validNode(node, chapter, files)) return null

    if (seen.size === 0 ? node.parent !== null : node.parent === null || !seen.has(node.parent))
      return null
    seen.add(node.id)
  }

  return tree
}

export const validateTourCallouts = (
  callouts: TourCallouts,
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
) => callouts.filter((callout) => validTarget(callout.target, chapter, files))

export const repairChapterVisuals = (
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
): Chapter => {
  const repaired = { ...chapter }

  if (chapter.diagram != null)
    repaired.diagram = validateTourDiagram(chapter.diagram, chapter, files)

  if (chapter.callTree != null)
    repaired.callTree = validateTourCallTree(chapter.callTree, chapter, files)

  if (chapter.callouts !== undefined)
    repaired.callouts = validateTourCallouts(chapter.callouts, chapter, files)

  // A Chapter shows one map. The diagram wins because it also carries branches and
  // flow steps; a call tree survives only when no usable diagram does.
  if (repaired.diagram != null && repaired.callTree != null) repaired.callTree = null

  return repaired
}

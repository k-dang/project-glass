import type {
  ChangedFile,
  Chapter,
  TourDiagram,
  TourDiagramNode,
  TourBeforeAfter,
  TourCallouts,
} from "@glass/contracts"
import { rangeInFiles } from "./github/patchLines"

const validNode = (
  node: Pick<TourDiagramNode, "change" | "target">,
  files: ReadonlyArray<ChangedFile>,
) =>
  (node.change !== "added" || node.target.side === "new") &&
  (node.change !== "removed" || node.target.side === "old") &&
  rangeInFiles(files, node.target)

export const validateTourDiagram = (
  diagram: TourDiagram,
  files: ReadonlyArray<ChangedFile>,
): TourDiagram | null => {
  const ids = new Set(diagram.nodes.map((node) => node.id))

  if (ids.size !== diagram.nodes.length) return null

  if (!diagram.nodes.every((node) => validNode(node, files))) return null

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

export const validateTourBeforeAfter = (
  beforeAfter: TourBeforeAfter,
  files: ReadonlyArray<ChangedFile>,
): TourBeforeAfter | null => {
  const changed = beforeAfter.lines.filter((line) => line.change !== "unchanged")

  if (changed.length === 0) return null

  if (
    !changed.every(({ change, target }) => target !== null && validNode({ change, target }, files))
  )
    return null

  return {
    ...beforeAfter,
    lines: beforeAfter.lines.map((line) =>
      line.target === null || rangeInFiles(files, line.target) ? line : { ...line, target: null },
    ),
  }
}

export const validateTourCallouts = (callouts: TourCallouts, files: ReadonlyArray<ChangedFile>) =>
  callouts.filter((callout) => rangeInFiles(files, callout.target))

export const repairChapterVisuals = (
  chapter: Chapter,
  files: ReadonlyArray<ChangedFile>,
): Chapter => {
  const repaired = { ...chapter }
  const inChapter = files.filter((file) => chapter.files.some(({ path }) => path === file.path))

  if (chapter.diagram != null) repaired.diagram = validateTourDiagram(chapter.diagram, inChapter)

  if (chapter.beforeAfter != null)
    repaired.beforeAfter = validateTourBeforeAfter(chapter.beforeAfter, inChapter)

  if (chapter.callouts != null)
    repaired.callouts = validateTourCallouts(chapter.callouts, inChapter)

  // A Chapter shows one map. The diagram wins because it also carries branches and
  // flow steps; a Before / after survives only when no usable diagram does.
  if (repaired.diagram != null && repaired.beforeAfter != null) repaired.beforeAfter = null

  return repaired
}

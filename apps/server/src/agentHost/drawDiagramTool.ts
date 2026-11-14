import { Diagram, DRAW_DIAGRAM_TOOL } from "@glass/contracts"
import { render } from "pele"
import { replyTo, toolParameters } from "./hostTool"

export const drawDiagramDescription =
  "Draw a Diagram beside the conversation in Mermaid, or redraw one. Call it only when the user asks for a diagram or accepts your offer of one, never on your own. Calling it with a Diagram's title again replaces that Diagram, so keep the title when the user asks for changes and pick a new one only for a new Diagram."

export const drawDiagramParameters = toolParameters({
  title: [
    Diagram.fields.title,
    "A short name for the Diagram, shown above it. The same title redraws that Diagram.",
  ],
  kind: [
    Diagram.fields.kind,
    'What the Diagram shows: "existing" for how things work now, "proposed" for a design that doesn\'t exist yet, or "uncertain" when it rests on inferences you couldn\'t confirm.',
  ],
  mermaid: [
    Diagram.fields.mermaid,
    "The diagram in Mermaid syntax, such as a flowchart or sequence diagram. Glass draws no links or images.",
  ],
})

const DIAGRAM_DRAWN = "Glass shows this Diagram beside the conversation."

const refusal = (reason: string) =>
  `Glass couldn't draw this Diagram:\n${reason}\nFix it and call ${DRAW_DIAGRAM_TOOL} again.`

const pelesVerdict = (mermaid: string) => {
  try {
    render(mermaid)

    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Pele draws Diagrams in Glass, so its verdict here matches what the user will see. */
export const drawDiagram = replyTo(Diagram, ({ mermaid }) => {
  const reason = pelesVerdict(mermaid)

  return reason === null
    ? { accepted: true, text: DIAGRAM_DRAWN }
    : { accepted: false, text: refusal(reason) }
})

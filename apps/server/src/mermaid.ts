import { type DiagramType, render } from "pele"

export const drawWithPele = (
  mermaid: string,
): { readonly type: DiagramType } | { readonly problem: string } => {
  try {
    return { type: render(mermaid).type }
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) }
  }
}

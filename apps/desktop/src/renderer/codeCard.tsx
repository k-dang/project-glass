import type { CodeViewReactOptions } from "@pierre/diffs/react"
import type { ReactNode } from "react"

const HEADER_HEIGHT = 44

type CodeOptions = CodeViewReactOptions<undefined, undefined>

/**
 * Diffs' paddingBottom metric must match the rendered padding. Unified wrapping
 * keeps a scroll container; split wrapping adds padding to a shared grid.
 */
export const lineOptions = (
  wrap: boolean,
  headerHeight = HEADER_HEIGHT,
): Pick<CodeOptions, "overflow" | "unsafeCSS" | "itemMetrics"> =>
  wrap
    ? {
        overflow: "wrap",
        unsafeCSS: "[data-code] { scrollbar-width: none; } [data-diff] { padding-bottom: 0; }",
        itemMetrics: { diffHeaderHeight: headerHeight, paddingBottom: 0 },
      }
    : { overflow: "scroll", itemMetrics: { diffHeaderHeight: headerHeight } }

export const codeCardOptions: CodeOptions = lineOptions(true)

/** overflow: hidden can change sticky headers' scroll ancestor; overflow: clip does not. */
export const codeCardClassName =
  "[&_diffs-container]:overflow-clip [&_diffs-container]:rounded-lg [&_diffs-container]:ring-1 [&_diffs-container]:ring-border"

export function CodeCardHeader(props: { children: ReactNode }) {
  return (
    <div
      style={{ height: HEADER_HEIGHT }}
      className="flex items-center gap-3 rounded-t-lg border-b bg-muted px-3 text-sm"
    >
      {props.children}
    </div>
  )
}

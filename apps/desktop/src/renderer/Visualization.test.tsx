// @vitest-environment happy-dom
import { SHOW_VISUALIZATION_TOOL, ToolCallPart, VisualizationSized } from "@glass/contracts"
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, expect, it } from "vite-plus/test"
import { TurnParts } from "./TurnParts"

afterEach(cleanup)

const shown = ToolCallPart.make({
  toolCallId: "show-1",
  name: SHOW_VISUALIZATION_TOOL,
  inputSummary: "Latency by week",
  input: JSON.stringify({ title: "Latency by week", html: "<!doctype html>" }),
  output: JSON.stringify({
    visualization: { id: "visualization-1", title: "Latency by week" },
    message: "Shown",
  }),
  status: "done",
  parentToolCallId: null,
})

it("shows a Visualization inline in a sandboxed frame that fits the page's height", () => {
  render(<TurnParts parts={[shown]} />)

  const frame = screen.getByTitle<HTMLIFrameElement>("Latency by week")
  expect(frame.getAttribute("sandbox")).toBe("allow-scripts")
  expect(frame.getAttribute("src")).toMatch(
    /^glass-visualization:\/\/visualization-1\/#glass-theme=/,
  )

  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: VisualizationSized.make({ height: 432.4 }),
        source: frame.contentWindow,
      }),
    )
  })

  expect(frame.style.height).toBe("433px")
})

it("shows a failed Visualization as an ordinary tool call", () => {
  render(<TurnParts parts={[{ ...shown, status: "failed", output: "No doctype" }]} />)

  expect(screen.queryByTitle("Latency by week")).toBeNull()
  expect(screen.getByText(SHOW_VISUALIZATION_TOOL)).toBeTruthy()
})

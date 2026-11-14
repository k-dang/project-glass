// @vitest-environment happy-dom
import { cleanup, render, waitFor } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vite-plus/test"
import { MermaidDiagram } from "./MermaidDiagram"

afterEach(cleanup)

const hostile = [
  "flowchart LR",
  '  A["<script>alert(1)</script><img src=x onerror=alert(1)>"] --> B',
  '  click A "javascript:alert(1)"',
  '  click B "https://example.com/x"',
  '  C@{ img: "https://example.com/i.png", label: "img" }',
].join("\n")

it("draws an Agent's diagram without scripts, links, or remote images", async () => {
  const onInvalid = vi.fn<() => void>()
  const { container } = render(<MermaidDiagram source={hostile} onInvalid={onInvalid} />)

  await waitFor(() => expect(container.querySelectorAll(".pele-node")).toHaveLength(3))
  expect(container.textContent).toContain("alert(1)")
  expect(container.querySelector("script, a, image, foreignObject, [onerror]")).toBeNull()
  expect(container.innerHTML).not.toContain("example.com")
  expect(onInvalid).not.toHaveBeenCalled()
})

it("reports a diagram that doesn't parse", async () => {
  const onInvalid = vi.fn<() => void>()
  render(<MermaidDiagram source={"flowchart LR\n  A -->> [["} onInvalid={onInvalid} />)

  await waitFor(() => expect(onInvalid).toHaveBeenCalled())
})

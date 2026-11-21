// @vitest-environment happy-dom
import { renderHook, waitFor } from "@testing-library/react"
import { isValidElement, type ReactNode } from "react"
import { expect, it } from "vite-plus/test"
import { useHighlightedCode } from "./use-highlighted-code"

const code = "const a = 1\nconst b = 2"

const highlighted = (lines: ReadonlyArray<ReactNode>) =>
  lines.every((line) => Array.isArray(line) && line.every((token) => isValidElement(token)))

it("highlights a remounted code block on its first render", async () => {
  const first = renderHook(() => useHighlightedCode(code, "ts"))

  await waitFor(() => expect(highlighted(first.result.current)).toBe(true))
  first.unmount()

  const renders: Array<ReadonlyArray<ReactNode>> = []

  renderHook(() => {
    const lines = useHighlightedCode(code, "ts")
    renders.push(lines)

    return lines
  })

  expect(renders.map(highlighted)).toEqual(renders.map(() => true))
})

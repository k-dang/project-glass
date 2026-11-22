import * as React from "react"

import { type Highlighter, loadHighlighter, loadedHighlighter } from "@/lib/highlighter"

export function useHighlightedCode(value: string, language: string) {
  const code = value.endsWith("\n") ? value.slice(0, -1) : value
  const ready = loadedHighlighter(language)
  const highlighter = ready ?? null
  const [, rerender] = React.useReducer((loads: number) => loads + 1, 0)

  React.useEffect(() => {
    if (ready !== undefined) return undefined

    let cancelled = false

    loadHighlighter(language)
      .then(() => {
        if (!cancelled) rerender()
      })
      .catch(() => {})

    return () => {
      cancelled = true
    }
  }, [language, ready])

  const [done, setDone] = React.useState<{
    highlighter: Highlighter | null
    text: string
    lines: React.ReactNode[]
    state?: Parameters<Highlighter["highlight"]>[1]
  }>({ highlighter: null, text: "", lines: [] })

  let next = done

  if (next.highlighter !== highlighter || !code.startsWith(next.text)) {
    next = { highlighter, text: "", lines: [] }
  }

  const end = code.lastIndexOf("\n") + 1

  if (highlighter && end > next.text.length) {
    const result = highlighter.highlight(code.slice(next.text.length, end - 1), next.state)

    next = {
      highlighter,
      text: code.slice(0, end),
      lines: [...next.lines, ...result.lines],
      state: result.state,
    }
  }

  if (next !== done) {
    setDone(next)
  }

  const tail = code.slice(end)

  return React.useMemo(() => {
    if (!highlighter) {
      return code.split("\n")
    }

    return [...next.lines, highlighter.highlight(tail, next.state).lines[0]]
  }, [code, highlighter, next, tail])
}

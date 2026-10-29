import { useEffect, useState } from "react"

export function Elapsed(props: { startedAt: number }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)

    return () => window.clearInterval(timer)
  }, [])

  return (
    <span
      aria-label="Time elapsed"
      className="font-mono text-xs text-muted-foreground tabular-nums"
    >
      {Math.max(0, Math.floor((now - props.startedAt) / 1000))}s
    </span>
  )
}

import { useEffect, useState } from "react"

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

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
      {clock(Math.max(0, Math.floor((now - props.startedAt) / 1000)))}
    </span>
  )
}

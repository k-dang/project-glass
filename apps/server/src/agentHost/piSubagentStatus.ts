// WARNING: Follows pi-subagents' documented lifecycle events, which its terminal widget shows but pi's RPC mode drops.
export const piSubagentStatusExtension = `
export default function (pi) {
  const running = new Map()
  let ui

  const show = () => {
    const shown = [...running.values()]
    ui?.setStatus(
      "glass-subagents",
      shown.length === 0
        ? undefined
        : "Running " + (shown.length === 1 ? "a subagent" : shown.length + " subagents") + ": " + shown.join(", "),
    )
  }

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui
  })

  pi.events.on("subagents:started", ({ id, type, description }) => {
    running.set(id, type + ": " + description)
    show()
  })

  for (const ended of ["subagents:completed", "subagents:failed"])
    pi.events.on(ended, ({ id }) => {
      if (running.delete(id)) show()
    })
}
`

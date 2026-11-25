import { createContext, useState } from "react"

export const ShellPanelSlot = createContext<HTMLElement | null>(null)

export const ShellTitleSlot = createContext<HTMLElement | null>(null)

export function useShellSlot() {
  const [shellSlot] = useState(() => {
    const slot = Object.assign(document.createElement("div"), { className: "contents" })

    return [slot, (host: HTMLElement | null) => host?.append(slot)] as const
  })

  return shellSlot
}

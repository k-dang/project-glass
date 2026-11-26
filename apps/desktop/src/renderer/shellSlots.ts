import { type Context, createContext, use, useState } from "react"

export const ShellPanelSlot = createContext<HTMLElement | null>(null)

export const ShellTitleSlot = createContext<HTMLElement | null>(null)

export function useShellSlotHost(slot: Context<HTMLElement | null>) {
  const host = use(slot)

  if (host === null) throw new Error("Rendered outside the app shell")

  return host
}

export function useShellSlot() {
  const [shellSlot] = useState(() => {
    const slot = Object.assign(document.createElement("div"), { className: "contents" })

    return [slot, (host: HTMLElement | null) => host?.append(slot)] as const
  })

  return shellSlot
}

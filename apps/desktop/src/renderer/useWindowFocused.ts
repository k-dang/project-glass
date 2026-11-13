import { useSyncExternalStore } from "react"

const events = ["focus", "blur", "visibilitychange"] as const

const subscribe = (onChange: () => void) => {
  for (const event of events) window.addEventListener(event, onChange)

  return () => {
    for (const event of events) window.removeEventListener(event, onChange)
  }
}

const focused = () => document.visibilityState === "visible" && document.hasFocus()

export const useWindowFocused = () => useSyncExternalStore(subscribe, focused)

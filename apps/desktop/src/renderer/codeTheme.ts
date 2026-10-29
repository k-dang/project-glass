import type { Theme } from "@glass/contracts"
import { registerCustomTheme } from "@pierre/diffs"
import { useWorkerPool } from "@pierre/diffs/react"
import { useEffect } from "react"
import { useTheme } from "./theme"

registerCustomTheme("glass-charcoal", () => import("./charcoal").then((module) => module.charcoal))

const defaultCodeTheme = { dark: "pierre-dark", light: "pierre-light" }

export const codeThemeFor = (theme: Theme) =>
  theme === "charcoal" ? "glass-charcoal" : defaultCodeTheme

export function CodeThemeSync() {
  const { theme } = useTheme()
  const pool = useWorkerPool()

  useEffect(() => {
    void pool?.setRenderOptions({ theme: codeThemeFor(theme) })
  }, [pool, theme])

  return null
}

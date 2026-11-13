import type { Theme } from "@glass/contracts"
import { registerCustomTheme } from "@pierre/diffs"
import { useWorkerPool } from "@pierre/diffs/react"
import { useEffect } from "react"
import { useAppearance } from "./theme"

registerCustomTheme("glass-charcoal", () => import("./charcoal").then((module) => module.charcoal))

const pierre = { dark: "pierre-dark", light: "pierre-light" }

const codeThemes = {
  glass: pierre,
  charcoal: { dark: "glass-charcoal", light: "pierre-light" },
  catppuccin: { dark: "catppuccin-mocha", light: "catppuccin-latte" },
  linear: pierre,
  vercel: pierre,
} satisfies Record<Theme, { dark: string; light: string }>

export const codeThemeFor = (theme: Theme) => codeThemes[theme]

export function CodeThemeSync() {
  const { theme } = useAppearance()
  const pool = useWorkerPool()

  useEffect(() => {
    void pool?.setRenderOptions({ theme: codeThemeFor(theme) })
  }, [pool, theme])

  return null
}

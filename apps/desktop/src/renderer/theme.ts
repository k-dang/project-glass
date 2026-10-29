import type { ColorScheme, Theme } from "@glass/contracts"
import { useAtom } from "@effect/atom-react"
import { Atom } from "effect/reactivity"

const storageKey = "glass.theme"

const themeAtom = Atom.writable(savedTheme, (ctx, theme: Theme) => {
  localStorage.setItem(storageKey, theme)
  ctx.setSelf(theme)
}).pipe(Atom.keepAlive)

export function savedTheme(): Theme {
  const saved = localStorage.getItem(storageKey)

  if (saved === "light" || saved === "dark" || saved === "system" || saved === "charcoal")
    return saved

  return "system"
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme

  return window.glass.setTheme(theme)
}

const colorSchemeTimeout = 300

const colorSchemeFollows = (colorScheme: ColorScheme) =>
  new Promise<void>((resolve) => {
    const scheme = window.matchMedia("(prefers-color-scheme: dark)")

    if (scheme.matches === (colorScheme === "dark")) {
      resolve()

      return
    }

    const done = () => {
      clearTimeout(timeout)
      scheme.removeEventListener("change", done)
      resolve()
    }

    const timeout = setTimeout(done, colorSchemeTimeout)

    scheme.addEventListener("change", done)
  })

function transitionTheme(theme: Theme) {
  document.startViewTransition({
    types: ["theme"],
    update: async () => {
      await colorSchemeFollows(await applyTheme(theme))
    },
  })
}

export function useTheme() {
  const [theme, saveTheme] = useAtom(themeAtom)

  return {
    theme,
    setTheme: (next: Theme) => {
      saveTheme(next)
      transitionTheme(next)
    },
  }
}

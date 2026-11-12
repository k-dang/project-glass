import { type Appearance, type ColorScheme, ColorSchemePreference, Theme } from "@glass/contracts"
import { useAtom } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { Atom } from "effect/reactivity"

const themeKey = "glass.theme"

const colorSchemeKey = "glass.colorScheme"

const appearanceAtom = Atom.writable(savedAppearance, (ctx, appearance: Appearance) => {
  localStorage.setItem(themeKey, appearance.theme)
  localStorage.setItem(colorSchemeKey, appearance.colorScheme)
  ctx.setSelf(appearance)
}).pipe(Atom.keepAlive)

const decodeTheme = Schema.decodeUnknownOption(Theme)

const decodeColorScheme = Schema.decodeUnknownOption(ColorSchemePreference)

export function savedAppearance(): Appearance {
  return {
    theme: Option.getOrElse(decodeTheme(localStorage.getItem(themeKey)), () => "glass" as const),
    colorScheme: Option.getOrElse(
      decodeColorScheme(localStorage.getItem(colorSchemeKey)),
      () => "system" as const,
    ),
  }
}

export function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.theme = appearance.theme

  return window.glass.setAppearance(appearance)
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

function transitionAppearance(appearance: Appearance) {
  document.startViewTransition({
    types: ["theme"],
    update: async () => {
      await colorSchemeFollows(await applyAppearance(appearance))
    },
  })
}

export function useAppearance() {
  const [appearance, saveAppearance] = useAtom(appearanceAtom)

  const change = (next: Appearance) => {
    saveAppearance(next)
    transitionAppearance(next)
  }

  return {
    ...appearance,
    setTheme: (theme: Theme) => change({ ...appearance, theme }),
    setColorScheme: (colorScheme: ColorSchemePreference) => change({ ...appearance, colorScheme }),
  }
}

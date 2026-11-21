import {
  type Appearance,
  type ColorScheme,
  ColorSchemePreference,
  Layout,
  Theme,
} from "@glass/contracts"
import { useAtom } from "@effect/atom-react"
import { Option, Schema } from "effect"
import { Atom } from "effect/reactivity"

const themeKey = "glass.theme"

const colorSchemeKey = "glass.colorScheme"

const layoutKey = "glass.layout"

const appearanceAtom = Atom.writable(savedAppearance, (ctx, appearance: Appearance) => {
  localStorage.setItem(themeKey, appearance.theme)
  localStorage.setItem(colorSchemeKey, appearance.colorScheme)
  localStorage.setItem(layoutKey, appearance.layout)
  ctx.setSelf(appearance)
}).pipe(Atom.keepAlive)

const saved = <A>(key: string, schema: Schema.Codec<A>, fallback: A): A =>
  Option.getOrElse(Schema.decodeUnknownOption(schema)(localStorage.getItem(key)), () => fallback)

export function savedAppearance(): Appearance {
  return {
    theme: saved(themeKey, Theme, "glass"),
    colorScheme: saved(colorSchemeKey, ColorSchemePreference, "system"),
    layout: saved(layoutKey, Layout, "classic"),
  }
}

export function applyAppearance(appearance: Appearance) {
  document.documentElement.dataset.theme = appearance.theme
  document.documentElement.dataset.layout = appearance.layout

  return window.glass.setAppearance(appearance)
}

const colorSchemeTimeout = 300

const darkScheme = window.matchMedia("(prefers-color-scheme: dark)")

const colorSchemeFollows = (colorScheme: ColorScheme) =>
  new Promise<void>((resolve) => {
    if (darkScheme.matches === (colorScheme === "dark")) {
      resolve()

      return
    }

    const done = () => {
      clearTimeout(timeout)
      darkScheme.removeEventListener("change", done)
      resolve()
    }

    const timeout = setTimeout(done, colorSchemeTimeout)

    darkScheme.addEventListener("change", done)
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
    setLayout: (layout: Layout) => change({ ...appearance, layout }),
  }
}

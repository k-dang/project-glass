import { Schema } from "effect"

export const Theme = Schema.Literals(["glass", "charcoal", "catppuccin", "linear", "vercel"])

export type Theme = typeof Theme.Type

export const ColorSchemePreference = Schema.Literals(["system", "light", "dark"])

export type ColorSchemePreference = typeof ColorSchemePreference.Type

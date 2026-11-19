import type { MouseEvent } from "react"
import type { Shot } from "../shot.ts"

export type Scheme = "light" | "dark"

export const schemeOptions = [
  ["light", "Light"],
  ["dark", "Dark"],
  ["both", "Both"],
] as const

export type SchemeChoice = (typeof schemeOptions)[number][0]

export const viewOptions = [
  ["single", "One"],
  ["grid", "Grid"],
  ["canvas", "Canvas"],
] as const

export type View = (typeof viewOptions)[number][0]

export const framingOptions = [
  ["focus", "Focus"],
  ["whole", "Whole window"],
] as const

export type Framing = (typeof framingOptions)[number][0]

export type Detail = "thumb" | "full"

export const schemesShown = (scheme: SchemeChoice): ReadonlyArray<Scheme> =>
  scheme === "both" ? ["light", "dark"] : [scheme]

export const sizeOf = (shot: Shot, framing: Framing) =>
  framing === "whole" ? shot : (shot.focus ?? shot)

export const src = (shot: Shot, shown: Scheme, framing: Framing, detail: Detail = "full") =>
  `shots/${shot.id}-${shown}${framing === "whole" || shot.focus === null ? "" : "-focus"}${detail === "thumb" ? "-thumb" : ""}.png`

export const alt = (shot: Shot, shown: Scheme) => `${shot.area}: ${shot.name} (${shown})`

export const matches = (shot: Shot, query: string) =>
  `${shot.area} ${shot.name}`.toLowerCase().includes(query.toLowerCase())

export const openOnClick = (open: (id: string) => void, id: string) => (event: MouseEvent) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  event.preventDefault()
  open(id)
}

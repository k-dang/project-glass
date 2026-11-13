import type { Hotspot } from "@glass/contracts"

export interface RankedHotspot {
  readonly rank: number
  readonly hotspot: Hotspot
}

export const rankHotspots = (hotspots: ReadonlyArray<Hotspot>): ReadonlyArray<RankedHotspot> =>
  hotspots.map((hotspot, index) => ({ rank: index + 1, hotspot }))

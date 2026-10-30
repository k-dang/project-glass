// PROTOTYPE (queue-status-alignment), throwaway. Question: where should a Queued PR's Tour
// status sit so it lines up row to row? Four variants of the Queue tab, flipped with the
// floating bar or ←/→. Electron has no address bar, so the pick lives in localStorage
// rather than a `?variant=` param, which keeps it stable across reloads.
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"

export const variants = [
  { key: "0", name: "Current: inline after title" },
  { key: "A", name: "Status column after title" },
  { key: "B", name: "Icon column beside checks" },
  { key: "C", name: "Grouped by Tour status" },
] as const

export type VariantKey = (typeof variants)[number]["key"]

export const variantColumns: Record<VariantKey, string> = {
  "0": "grid-cols-[0_1rem_minmax(0,1fr)_fit-content(9rem)_3.5rem_7rem_2rem_0]",
  A: "grid-cols-[0_1rem_minmax(0,1fr)_fit-content(8rem)_fit-content(9rem)_3.5rem_7rem_2rem_0]",
  B: "grid-cols-[0_1rem_1rem_minmax(0,1fr)_fit-content(9rem)_3.5rem_7rem_2rem_0]",
  C: "grid-cols-[0_1rem_minmax(0,1fr)_fit-content(9rem)_3.5rem_7rem_2rem_0]",
}

const storageKey = "prototype:queue-status-variant"

const listeners = new Set<(key: VariantKey) => void>()

const stored = (): VariantKey =>
  variants.find(({ key }) => key === localStorage.getItem(storageKey))?.key ?? "0"

const choose = (key: VariantKey) => {
  localStorage.setItem(storageKey, key)

  for (const listener of listeners) listener(key)
}

export const useVariant = () => {
  const [variant, setVariant] = useState(stored)

  useEffect(() => {
    listeners.add(setVariant)

    return () => void listeners.delete(setVariant)
  }, [])

  return variant
}

const step = (from: VariantKey, by: number) => {
  const index = variants.findIndex(({ key }) => key === from)

  return variants[(index + by + variants.length) % variants.length]!.key
}

export function PrototypeSwitcher() {
  const variant = useVariant()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const { target } = event

      if (target instanceof Element && target.closest("input, textarea, [contenteditable]")) return

      if (event.key === "ArrowLeft") choose(step(variant, -1))

      if (event.key === "ArrowRight") choose(step(variant, 1))
    }

    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  }, [variant])

  if (!import.meta.env.DEV) return null

  const current = variants.find(({ key }) => key === variant)!

  return (
    <div className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-fuchsia-600 px-2 py-1 text-sm text-white shadow-lg">
      <button type="button" aria-label="Previous variant" onClick={() => choose(step(variant, -1))}>
        <ChevronLeft className="size-4" />
      </button>
      <span className="tabular-nums">
        {current.key} ({current.name})
      </span>
      <button type="button" aria-label="Next variant" onClick={() => choose(step(variant, 1))}>
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

// PROTOTYPE: throwaway variant switcher. Never merge to main.
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useEffect, useState } from "react"

const storageKey = "prototype-variant"

const readVariant = (keys: ReadonlyArray<string>) => {
  const value = localStorage.getItem(storageKey)

  return value !== null && keys.includes(value) ? value : keys[0]!
}

export function usePrototypeVariant(keys: ReadonlyArray<string>) {
  const [variant, setVariant] = useState(() => readVariant(keys))

  const choose = (next: string) => {
    localStorage.setItem(storageKey, next)
    setVariant(next)
  }

  return [variant, choose] as const
}

export function PrototypeSwitcher(props: {
  variants: ReadonlyArray<{ key: string; name: string }>
  current: string
  onChange: (key: string) => void
}) {
  const index = props.variants.findIndex((variant) => variant.key === props.current)
  const step = (by: number) =>
    props.onChange(
      props.variants[(index + by + props.variants.length) % props.variants.length]!.key,
    )

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target?.closest("input, textarea, [contenteditable]")) return
      if (event.key === "ArrowLeft" && event.altKey) step(-1)
      if (event.key === "ArrowRight" && event.altKey) step(1)
    }
    window.addEventListener("keydown", onKey)

    return () => window.removeEventListener("keydown", onKey)
  })

  const current = props.variants[index]

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-1 rounded-full bg-fuchsia-600 px-1 py-1 text-sm text-white shadow-xl ring-2 ring-white/30">
      <button
        type="button"
        className="rounded-full p-1.5 hover:bg-white/20"
        onClick={() => step(-1)}
        title="Previous variant (Alt+←)"
      >
        <ChevronLeft className="size-4" />
      </button>
      <span className="min-w-56 text-center font-medium">
        {current?.key} · {current?.name}
      </span>
      <button
        type="button"
        className="rounded-full p-1.5 hover:bg-white/20"
        onClick={() => step(1)}
        title="Next variant (Alt+→)"
      >
        <ChevronRight className="size-4" />
      </button>
    </div>
  )
}

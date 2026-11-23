import { type RefObject, useLayoutEffect, useRef } from "react"

const offsetOf = (element: HTMLElement) => {
  const translate = getComputedStyle(element).translate

  return translate === "none" ? 0 : Number.parseFloat(translate.split(" ")[1] ?? "0")
}

export function useShift(container: RefObject<HTMLElement | null>) {
  const last = useRef({ order: "", tops: new Map<string, number>() })

  useLayoutEffect(() => {
    const root = container.current

    if (root === null) return

    const items = [...root.querySelectorAll<HTMLElement>("[data-shift-key]")]
    const order = items.map((item) => item.dataset.shiftKey).join("\n")
    const changed = order !== last.current.order
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out")
    const origin = root.getBoundingClientRect().top
    const tops = new Map<string, number>()

    for (const item of items) {
      const key = item.dataset.shiftKey ?? ""
      const offset = offsetOf(item)
      const top = item.getBoundingClientRect().top - origin - offset
      tops.set(key, top)

      const before = last.current.tops.get(key)

      if (!changed || still || before === undefined) continue

      const from = before + offset - top

      if (Math.abs(from) < 1) continue

      for (const running of item.getAnimations()) if (running.id === "shift") running.cancel()

      const shift = item.animate([{ translate: `0 ${from}px` }, { translate: "0 0" }], {
        duration: 200,
        easing,
      })

      shift.id = "shift"
    }

    last.current = { order, tops }
  })
}

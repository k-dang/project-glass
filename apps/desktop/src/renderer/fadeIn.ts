export const fadeIn = (element: HTMLElement, from: Keyframe, duration: number) => {
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  const easing = getComputedStyle(document.documentElement).getPropertyValue("--ease-out")

  return element.animate([still ? { opacity: 0 } : { opacity: 0, ...from }, {}], {
    duration,
    easing,
  })
}

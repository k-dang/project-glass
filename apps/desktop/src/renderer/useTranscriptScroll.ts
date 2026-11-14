import type { Turn } from "@glass/contracts"
import { Predicate } from "effect"
import { type UIEvent, useLayoutEffect, useRef, useState } from "react"

export const ANCHORED_TURN_CLASS = "min-h-[calc(100cqh-3rem)]"

const END_SLACK_PX = 8

const isWorking = (turn: Turn) =>
  turn.parts.some((part) => !Predicate.isTagged(part, "Text") && !Predicate.isTagged(part, "Steer"))

const motion = (): ScrollBehavior =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth"

const scrollToEnd = (viewport: HTMLElement, behavior: ScrollBehavior) =>
  viewport.scrollTo({ top: viewport.scrollHeight, behavior })

export function useTranscriptScroll(turns: ReadonlyArray<Turn>) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [following, setFollowing] = useState(true)
  const [sent, setSent] = useState<string>()
  const latest = turns.at(-1)
  const [seen, setSeen] = useState(latest?.id)

  if (latest?.id !== seen) {
    setSeen(latest?.id)

    if (following && turns.at(-2)?.id === seen) setSent(latest?.id)
  }

  const anchored =
    latest !== undefined && latest.id === sent && !isWorking(latest) ? latest.id : undefined

  const live = useRef({ following, anchored })

  useLayoutEffect(() => {
    live.current = { following, anchored }
  })

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current

    if (viewport === null || content === null) return undefined

    const observer = new ResizeObserver(() => {
      if (live.current.following && live.current.anchored === undefined)
        scrollToEnd(viewport, "instant")
    })

    observer.observe(viewport)
    observer.observe(content)

    return () => observer.disconnect()
  }, [])

  const positioned = useRef({ anchored, height: 0 })

  useLayoutEffect(() => {
    const viewport = viewportRef.current

    if (positioned.current.anchored === anchored || viewport === null) return

    positioned.current = { anchored, height: viewport.scrollHeight }

    if (following) scrollToEnd(viewport, motion())
  }, [anchored, following])

  const returnToEnd = () => {
    setFollowing(true)
    setSent(undefined)
  }

  const scrolled = useRef({ top: 0, height: 0 })

  const onScroll = (event: UIEvent<HTMLElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = event.currentTarget
    const before = scrolled.current
    const atEnd = scrollHeight - scrollTop - clientHeight <= END_SLACK_PX

    scrolled.current = { top: scrollTop, height: scrollHeight }

    if (!following) {
      if (atEnd) returnToEnd()
    } else if (scrollTop < before.top && scrollHeight >= before.height) setFollowing(false)
    else if (anchored !== undefined && atEnd && scrollHeight > positioned.current.height)
      returnToEnd()
  }

  const jumpToEnd = () => {
    returnToEnd()

    if (viewportRef.current !== null) scrollToEnd(viewportRef.current, motion())
  }

  return {
    viewportProps: { ref: viewportRef, onScroll },
    contentRef,
    anchored,
    following,
    jumpToEnd,
  }
}

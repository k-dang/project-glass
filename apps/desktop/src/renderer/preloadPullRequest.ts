import { useAtomSet } from "@effect/atom-react"
import type { PullRequestRef } from "@glass/contracts"
import { useRouter } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { preloadPullRequestAtom } from "./reviewsArea"

const HOVER_INTENT_MS = 100

export const usePreloadOnHover = (ref: PullRequestRef) => {
  const preloadData = useAtomSet(preloadPullRequestAtom)
  const router = useRouter()
  const pending = useRef<ReturnType<typeof setTimeout>>(undefined)

  const preload = () => {
    preloadData(ref)
    void router.preloadRoute({
      to: "/reviews/$owner/$repo/$number",
      params: ref,
    })
  }

  const cancel = () => clearTimeout(pending.current)

  useEffect(() => () => clearTimeout(pending.current), [])

  return {
    onPointerEnter: () => {
      cancel()
      pending.current = setTimeout(preload, HOVER_INTENT_MS)
    },
    onPointerLeave: cancel,
    onPointerDown: () => {
      cancel()
      preload()
    },
  }
}

export function PreloadPullRequest(props: { pullRequest: PullRequestRef }) {
  const preloadData = useAtomSet(preloadPullRequestAtom)
  const [ref] = useState(props.pullRequest)

  useEffect(() => preloadData(ref), [preloadData, ref])

  return null
}

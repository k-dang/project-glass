import { useAtomValue } from "@effect/atom-react"
import { CheckIn } from "@glass/contracts"
import { useNavigate } from "@tanstack/react-router"
import { Schema } from "effect"
import { AsyncResult } from "effect/reactivity"
import { useEffect, useRef } from "react"
import { watchedNeedsYouAtom } from "./needsYou"

export function useOpenNewCheckIns() {
  const navigate = useNavigate()
  const needsYou = useAtomValue(watchedNeedsYouAtom)
  const known = useRef<ReadonlySet<string> | null>(null)

  useEffect(() => {
    if (!AsyncResult.isSuccess(needsYou)) return

    const ids = needsYou.value.filter(Schema.is(CheckIn)).map(({ id }) => id)
    const arrived = known.current === null ? [] : ids.filter((id) => !known.current?.has(id))
    known.current = new Set(ids)

    const checkInId = arrived.at(-1)

    if (checkInId === undefined) return

    void window.glass.bringToFront()
    void navigate({ to: "/inbox/check-ins/$checkInId", params: { checkInId } })
  }, [needsYou, navigate])
}

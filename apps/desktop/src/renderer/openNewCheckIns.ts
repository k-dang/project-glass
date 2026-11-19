import { CheckIn } from "@glass/contracts"
import { Schema } from "effect"
import { AsyncResult, type AtomRegistry } from "effect/reactivity"
import { watchedNeedsYouAtom } from "./needsYou"

export const openNewCheckIns = (
  registry: AtomRegistry.AtomRegistry,
  open: (checkInId: string) => void,
) => {
  let known: ReadonlySet<string> | null = null

  registry.subscribe(
    watchedNeedsYouAtom,
    (needsYou) => {
      if (!AsyncResult.isSuccess(needsYou)) return

      const ids = needsYou.value.filter(Schema.is(CheckIn)).map(({ id }) => id)
      const arrived = known === null ? [] : ids.filter((id) => !known?.has(id))
      known = new Set(ids)

      const checkInId = arrived.at(-1)

      if (checkInId !== undefined) open(checkInId)
    },
    { immediate: true },
  )
}

import { CheckIn } from "@glass/contracts"
import { Schema } from "effect"
import { AsyncResult, type AtomRegistry } from "effect/reactivity"
import { watchedInboxAtom } from "./inboxArea"

export const openNewCheckIns = (
  registry: AtomRegistry.AtomRegistry,
  open: (checkInId: string) => void,
) => {
  let known: ReadonlySet<string> | null = null

  registry.subscribe(
    watchedInboxAtom,
    (inbox) => {
      if (!AsyncResult.isSuccess(inbox)) return

      const ids = inbox.value.filter(Schema.is(CheckIn)).map(({ id }) => id)
      const arrived = known === null ? [] : ids.filter((id) => !known?.has(id))
      known = new Set(ids)

      const checkInId = arrived.at(-1)

      if (checkInId !== undefined) open(checkInId)
    },
    { immediate: true },
  )
}
